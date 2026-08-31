const { parentPort } = require("worker_threads");

const SIMPLE_RETURN_IGNORED_FIELD_NAMES = new Set([
  "additional_properties",
  "field_dict",
  "note",
  "todo",
  "validation"
]);
const RETURN_FIELD_NAME_STYLES = new Set(["camelcase", "snake_case", "both"]);
const TYPE_PREVIEW_CACHE_MAX_ENTRIES_DEFAULT = 400;
const RETURN_TYPE_CACHE_SCHEMA_VERSION = 4;
const UNLIMITED_RETURN_FIELDS_PER_TYPE = Number.MAX_SAFE_INTEGER;

const WORKSPACE_INDEXES = new Map();

if (parentPort) {
  parentPort.on("message", async (message) => {
    const id = Number(message?.id);
    const type = String(message?.type || "");
    const payload = message?.payload;

    const respond = (result) => {
      parentPort.postMessage({ id, result });
    };
    const respondError = (error) => {
      const text = error && error.message ? error.message : String(error);
      parentPort.postMessage({ id, error: text });
    };

    try {
      if (!Number.isFinite(id) || !type) {
        return;
      }

      if (type === "clearAll") {
        WORKSPACE_INDEXES.clear();
        respond(true);
        return;
      }

      if (type === "clearWorkspace") {
        const workspaceKey = String(payload?.workspaceKey || "");
        if (workspaceKey) {
          WORKSPACE_INDEXES.delete(workspaceKey);
        }
        respond(true);
        return;
      }

      if (type === "setWorkspaceIndex") {
        const workspaceKey = String(payload?.workspaceKey || "");
        const generation = Number(payload?.generation || 0);
        if (!workspaceKey) {
          throw new Error("missing workspace key");
        }
        const previousWorkspaceEntry = WORKSPACE_INDEXES.get(workspaceKey);
        const hydratedIndex = hydrateReturnWorkerIndexSnapshot(payload?.snapshot || {});
        const cacheFingerprint = String(payload?.cacheFingerprint || "");
        const maxTypeCacheEntries = clampTypeCacheMaxEntries(payload?.maxTypeCacheEntries);
        const typePreviewCache =
          previousWorkspaceEntry?.typePreviewCache instanceof Map
            ? previousWorkspaceEntry.typePreviewCache
            : new Map();
        const typePreviewCacheKeysByFilePath =
          previousWorkspaceEntry?.typePreviewCacheKeysByFilePath instanceof Map
            ? previousWorkspaceEntry.typePreviewCacheKeysByFilePath
            : new Map();
        WORKSPACE_INDEXES.set(workspaceKey, {
          generation,
          cacheFingerprint,
          maxTypeCacheEntries,
          index: hydratedIndex,
          typePreviewCache,
          typePreviewCacheKeysByFilePath
        });
        trimTypePreviewCache(WORKSPACE_INDEXES.get(workspaceKey));
        respond(true);
        return;
      }

      if (type === "hydrateTypePreviewCache") {
        const workspaceKey = String(payload?.workspaceKey || "");
        const generation = Number(payload?.generation || 0);
        const workspaceEntry = WORKSPACE_INDEXES.get(workspaceKey);
        if (!workspaceEntry || Number(workspaceEntry.generation) !== generation) {
          respond(false);
          return;
        }
        const cacheFingerprint = String(payload?.cacheFingerprint || "");
        workspaceEntry.maxTypeCacheEntries = clampTypeCacheMaxEntries(payload?.maxTypeCacheEntries);
        if (workspaceEntry.cacheFingerprint !== cacheFingerprint) {
          workspaceEntry.cacheFingerprint = cacheFingerprint;
          workspaceEntry.typePreviewCache.clear();
        }
        const entries = sanitizePersistedTypeCacheEntries(payload?.entries || []);
        for (const item of entries) {
          const cacheKey = String(item.key || "");
          if (!cacheKey) {
            continue;
          }
          setTypePreviewCacheEntry(workspaceEntry, cacheKey, item.entry);
        }
        trimTypePreviewCache(workspaceEntry);
        respond(true);
        return;
      }

      if (type === "invalidateTypePreviewByFiles") {
        const workspaceKey = String(payload?.workspaceKey || "");
        const workspaceEntry = WORKSPACE_INDEXES.get(workspaceKey);
        if (!workspaceEntry) {
          respond(false);
          return;
        }
        const normalizedFilePaths = uniqueStrings(
          (Array.isArray(payload?.filePaths) ? payload.filePaths : [])
            .map((value) => normalizeDependencyFilePath(value))
            .filter(Boolean)
        );
        if (normalizedFilePaths.length === 0) {
          respond(false);
          return;
        }

        let removedCount = 0;
        for (const filePath of normalizedFilePaths) {
          const keys = workspaceEntry.typePreviewCacheKeysByFilePath?.get(filePath);
          if (!keys) {
            continue;
          }
          for (const cacheKey of [...keys]) {
            if (deleteTypePreviewCacheEntry(workspaceEntry, cacheKey)) {
              removedCount += 1;
            }
          }
          workspaceEntry.typePreviewCacheKeysByFilePath.delete(filePath);
        }
        respond(removedCount > 0);
        return;
      }

      if (type === "computeReturnPreview") {
        const workspaceKey = String(payload?.workspaceKey || "");
        const generation = Number(payload?.generation || 0);
        const workspaceEntry = WORKSPACE_INDEXES.get(workspaceKey);
        if (!workspaceEntry || Number(workspaceEntry.generation) !== generation) {
          respond(undefined);
          return;
        }
        const result = computeReturnPreviewFromSnapshot(workspaceEntry, payload?.payload || {});
        respond(result);
        return;
      }

      if (type === "computeReturnMemberCompletions") {
        const workspaceKey = String(payload?.workspaceKey || "");
        const generation = Number(payload?.generation || 0);
        const workspaceEntry = WORKSPACE_INDEXES.get(workspaceKey);
        if (!workspaceEntry || Number(workspaceEntry.generation) !== generation) {
          respond(undefined);
          return;
        }
        const result = computeReturnMemberCompletionsFromSnapshot(workspaceEntry, payload?.payload || {});
        respond(result);
        return;
      }

      throw new Error(`unsupported worker request: ${type}`);
    } catch (error) {
      respondError(error);
    }
  });
}

function hydrateReturnWorkerIndexSnapshot(snapshot) {
  return {
    structuredTypesByName: hydrateMap(snapshot?.structuredTypesByName, (candidates) =>
      (Array.isArray(candidates) ? candidates : []).map((candidate) => ({
        name: String(candidate?.name || ""),
        filePath: String(candidate?.filePath || ""),
        modulePath: String(candidate?.modulePath || ""),
        qualifiedName: String(candidate?.qualifiedName || ""),
        isDataclass: Boolean(candidate?.isDataclass),
        isIndexableWrapper: Boolean(candidate?.isIndexableWrapper),
        supportsCamelCaseAccess: Boolean(candidate?.supportsCamelCaseAccess),
        baseTypeNames: uniqueStrings((candidate?.baseTypeNames || []).map((value) => String(value || ""))),
        baseTypeRefs: (Array.isArray(candidate?.baseTypeRefs) ? candidate.baseTypeRefs : [])
          .map((baseTypeRef) => {
            const typeName = String(baseTypeRef?.typeName || "").trim();
            const preferredQualifiedNames = uniqueStrings(
              (Array.isArray(baseTypeRef?.preferredQualifiedNames) ? baseTypeRef.preferredQualifiedNames : [])
                .map((value) => String(value || "").trim())
                .filter(Boolean)
            );
            if (!typeName) {
              return undefined;
            }
            return {
              typeName,
              preferredQualifiedNames
            };
          })
          .filter(Boolean),
        fields: (candidate?.fields || []).map((field) => ({
          name: String(field?.name || ""),
          annotation: String(field?.annotation || "")
        })),
        properties: (candidate?.properties || []).map((field) => ({
          name: String(field?.name || ""),
          annotation: String(field?.annotation || "")
        }))
      }))
    ),
    enumsByName: hydrateMap(snapshot?.enumsByName, (candidates) =>
      (Array.isArray(candidates) ? candidates : []).map((candidate) => ({
        name: String(candidate?.name || ""),
        filePath: String(candidate?.filePath || ""),
        qualifiedName: String(candidate?.qualifiedName || ""),
        members: (candidate?.members || []).map((member) => ({
          name: String(member?.name || ""),
          valueLiteral: String(member?.valueLiteral || "")
        }))
      }))
    ),
    structuredTypesByQualifiedName: new Map(
      (snapshot?.structuredTypesByQualifiedNameKeys || []).map((name) => [String(name || ""), true])
    ),
    enumsByQualifiedName: new Map((snapshot?.enumsByQualifiedNameKeys || []).map((name) => [String(name || ""), true])),
    moduleInfoByFile: hydrateMap(snapshot?.moduleInfoByFile, (moduleInfo) => ({
      modulePath: String(moduleInfo?.modulePath || ""),
      packagePath: String(moduleInfo?.packagePath || "")
    })),
    localStructuredTypeNamesByFile: hydrateMap(snapshot?.localStructuredTypeNamesByFile, (names) =>
      new Set((names || []).map((value) => String(value || "")))
    ),
    localEnumNamesByFile: hydrateMap(snapshot?.localEnumNamesByFile, (names) =>
      new Set((names || []).map((value) => String(value || "")))
    ),
    typeImportAliasesByFile: hydrateMap(snapshot?.typeImportAliasesByFile, (aliasEntries) =>
      hydrateMap(aliasEntries, (specs) =>
        (Array.isArray(specs) ? specs : []).map((spec) => ({
          modulePath: String(spec?.modulePath || ""),
          symbolName: String(spec?.symbolName || "")
        }))
      )
    ),
    moduleImportAliasesByFile: hydrateMap(snapshot?.moduleImportAliasesByFile, (aliasEntries) =>
      hydrateMap(aliasEntries, (modulePath) => String(modulePath || ""))
    )
  };
}

function hydrateMap(entries, valueHydrator = (value) => value) {
  const map = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const key = String(entry?.[0] || "");
    map.set(key, valueHydrator(entry?.[1]));
  }
  return map;
}

function computeReturnPreviewFromSnapshot(workspaceEntry, payload) {
  const cacheResolution = resolveOrBuildTypePreviewCacheEntry(workspaceEntry, payload);
  if (!cacheResolution) {
    return undefined;
  }

  const simpleAccess = bindSimpleReturnAccessTemplate(
    String(payload?.variableToken || ""),
    cacheResolution.cacheEntry.simpleAccessTemplate,
    payload?.fieldNameStyle
  );
  return {
    simpleAccess,
    technicalStructureLines: cacheResolution.includeTechnical
      ? cacheResolution.cacheEntry.technicalStructureLines
      : [],
    cacheWrite: cacheResolution.cacheWrite
  };
}

function computeReturnMemberCompletionsFromSnapshot(workspaceEntry, payload) {
  const cacheResolution = resolveOrBuildTypePreviewCacheEntry(workspaceEntry, payload);
  if (!cacheResolution) {
    return undefined;
  }
  const pathSegments = sanitizeMemberPathSegments(payload?.pathSegments || []);
  const activeSegmentPrefix = normalizeMemberCompletionToken(payload?.activeSegmentPrefix || "");
  const completionMaxDepth = Math.max(1, Number(payload?.completionMaxDepth) || 1);
  const members = collectReturnMemberCompletionCandidatesFromTemplate(
    cacheResolution.cacheEntry.simpleAccessTemplate,
    pathSegments,
    activeSegmentPrefix,
    completionMaxDepth,
    payload?.fieldNameStyle
  );
  return {
    members,
    cacheWrite: cacheResolution.cacheWrite
  };
}

function resolveOrBuildTypePreviewCacheEntry(workspaceEntry, payload) {
  if (!workspaceEntry || !workspaceEntry.index) {
    return undefined;
  }
  const index = workspaceEntry.index;
  const rootTypeNames = uniqueStrings((payload?.rootTypeNames || []).map((value) => String(value || "")));
  if (rootTypeNames.length === 0) {
    return undefined;
  }
  const maxDepth = Math.max(1, Number(payload?.maxDepth) || 1);
  const maxFieldsPerType = normalizeReturnMaxFieldsPerTypeValue(payload?.maxFieldsPerType, 0);
  const includeTechnical = Boolean(payload?.includeTechnical);
  const technicalMaxDepth = Math.max(0, Number(payload?.technicalMaxDepth) || 0);
  const technicalMaxFieldsPerType = Math.max(1, Number(payload?.technicalMaxFieldsPerType) || 1);
  const fieldNameStyle = normalizeReturnFieldNameStyle(payload?.fieldNameStyle);
  const includeProperties = payload?.includeProperties !== false;
  const typePreferencesByName = hydrateTypePreferenceMap(payload?.typePreferencesByName);
  const subtypePolicy = hydrateSubtypePolicy(payload?.subtypePolicy);
  const returnTypeCacheKey = buildReturnTypeCacheKey({
    rootTypeNames,
    rootCollectionLike: Boolean(payload?.rootCollectionLike),
    typePreferencesByName,
    subtypePolicy,
    maxDepth,
    maxFieldsPerType,
    technicalMaxDepth,
    technicalMaxFieldsPerType,
    fieldNameStyle,
    includeProperties
  });

  let cacheEntry = getTypePreviewCacheEntry(workspaceEntry, returnTypeCacheKey);
  let cacheWrite = undefined;
  if (!cacheEntry) {
    const dependencyFilePaths = new Set();
    const simpleAccessTemplate = buildSimpleReturnAccessTemplate(rootTypeNames, index, {
      rootCollectionLike: Boolean(payload?.rootCollectionLike),
      subtypePolicy,
      typePreferencesByName,
      maxDepth,
      maxFieldsPerType,
      includeProperties,
      dependencyFilePaths
    });
    const technicalStructureLines = buildReturnStructureLines(
      rootTypeNames,
      index,
      {
        maxDepth: technicalMaxDepth,
        maxFieldsPerType: technicalMaxFieldsPerType,
        typePreferencesByName,
        subtypePolicy,
        includeProperties,
        dependencyFilePaths
      },
      "technical"
    );
    cacheEntry = {
      simpleAccessTemplate: sanitizeSimpleAccessTemplate(simpleAccessTemplate),
      technicalStructureLines: sanitizeTechnicalStructureLines(technicalStructureLines),
      dependencyFilePaths: uniqueStrings([...dependencyFilePaths])
    };
    setTypePreviewCacheEntry(workspaceEntry, returnTypeCacheKey, cacheEntry);
    cacheWrite = {
      key: returnTypeCacheKey,
      entry: serializeTypePreviewCacheEntry(cacheEntry)
    };
  }

  return {
    cacheEntry,
    cacheWrite,
    includeTechnical
  };
}

function buildReturnTypeCacheKey(options) {
  const normalizedRootTypeNames = uniqueStrings(
    (options?.rootTypeNames || [])
      .map((value) => normalizeComparableToken(value))
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right))
  );
  const normalizedTypePreferences = serializeTypePreferenceMapEntries(options?.typePreferencesByName);
  const policy = options?.subtypePolicy || {};
  const normalizedPolicy = {
    mode: String(policy.mode || "always").trim().toLowerCase(),
    includeSet: uniqueStrings([...(policy.includeSet || [])].map((value) => normalizeComparableToken(value))).sort(
      (left, right) => left.localeCompare(right)
    ),
    excludeSet: uniqueStrings([...(policy.excludeSet || [])].map((value) => normalizeComparableToken(value))).sort(
      (left, right) => left.localeCompare(right)
    )
  };
  return JSON.stringify({
    schemaVersion: RETURN_TYPE_CACHE_SCHEMA_VERSION,
    rootTypeNames: normalizedRootTypeNames,
    rootCollectionLike: Boolean(options?.rootCollectionLike),
    maxDepth: Math.max(1, Number(options?.maxDepth) || 1),
    maxFieldsPerType: serializeReturnMaxFieldsPerType(options?.maxFieldsPerType),
    technicalMaxDepth: Math.max(0, Number(options?.technicalMaxDepth) || 0),
    technicalMaxFieldsPerType: Math.max(1, Number(options?.technicalMaxFieldsPerType) || 1),
    fieldNameStyle: normalizeReturnFieldNameStyle(options?.fieldNameStyle),
    includeProperties: options?.includeProperties !== false,
    typePreferencesByName: normalizedTypePreferences,
    subtypePolicy: normalizedPolicy
  });
}

function normalizeReturnFieldNameStyle(value) {
  const normalized = String(value || "camelcase").trim().toLowerCase();
  if (RETURN_FIELD_NAME_STYLES.has(normalized)) {
    return normalized;
  }
  return "camelcase";
}

function normalizeReturnMaxFieldsPerTypeValue(value, fallback = 0) {
  const raw = Number(value);
  const normalizedFallback = Number(fallback);
  if (!Number.isFinite(raw)) {
    return Number.isFinite(normalizedFallback) ? normalizedFallback : 0;
  }
  if (raw <= 0) {
    return 0;
  }
  return Math.max(1, Math.min(5000, Math.round(raw)));
}

function getEffectiveReturnMaxFieldsPerType(value) {
  const normalized = normalizeReturnMaxFieldsPerTypeValue(value, 0);
  return normalized === 0 ? UNLIMITED_RETURN_FIELDS_PER_TYPE : normalized;
}

function serializeReturnMaxFieldsPerType(value) {
  const normalized = normalizeReturnMaxFieldsPerTypeValue(value, 0);
  return normalized === 0 ? "all" : normalized;
}

function snakeToCamelCaseAccessSegment(segment) {
  const rawSegment = String(segment || "").trim();
  if (!rawSegment) {
    return "";
  }
  if (!rawSegment.includes("_")) {
    return `${rawSegment[0].toLowerCase()}${rawSegment.slice(1)}`;
  }
  const parts = rawSegment
    .split("_")
    .filter(Boolean)
    .map((part) => {
      const trimmedPart = String(part || "").trim();
      return trimmedPart || "";
    })
    .filter(Boolean);
  if (parts.length === 0) {
    return "";
  }
  return `${parts[0][0].toLowerCase()}${parts[0].slice(1)}${parts
    .slice(1)
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join("")}`;
}

function getCamelCaseAccessAlias(segment, supportsCamelCaseAccess) {
  if (!supportsCamelCaseAccess) {
    return String(segment || "").trim();
  }
  return snakeToCamelCaseAccessSegment(segment) || String(segment || "").trim();
}

function getSegmentNameVariants(segment, supportsCamelCaseAccess, fieldNameStyle) {
  const rawSegment = String(segment || "").trim();
  if (!rawSegment) {
    return [];
  }
  const preferredSegment = getCamelCaseAccessAlias(rawSegment, supportsCamelCaseAccess);
  const normalizedStyle = normalizeReturnFieldNameStyle(fieldNameStyle);
  if (normalizedStyle === "snake_case") {
    return [rawSegment];
  }
  if (normalizedStyle === "both") {
    return uniqueStrings([rawSegment, preferredSegment]);
  }
  return uniqueStrings([preferredSegment]);
}

function getSegmentMatchVariants(segment, supportsCamelCaseAccess) {
  return uniqueStrings([
    String(segment || "").trim(),
    getCamelCaseAccessAlias(segment, supportsCamelCaseAccess)
  ]);
}

function buildVisibleTemplateSegmentVariants(levelTemplate, fieldNameStyle) {
  const segments = (Array.isArray(levelTemplate?.segments) ? levelTemplate.segments : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  if (segments.length === 0) {
    return [];
  }

  const camelCaseSegmentPositions = normalizeIndexedSegmentPositions(
    levelTemplate?.camelCaseSegmentPositions || [],
    segments.length
  );
  const preferredSegments = segments.map((segment, index) =>
    camelCaseSegmentPositions.has(index) ? getCamelCaseAccessAlias(segment, true) : segment
  );
  const normalizedStyle = normalizeReturnFieldNameStyle(fieldNameStyle);
  const candidates =
    normalizedStyle === "snake_case"
      ? [segments]
      : normalizedStyle === "both"
      ? [segments, preferredSegments]
      : [preferredSegments];
  const result = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const normalizedCandidate = (Array.isArray(candidate) ? candidate : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean);
    if (normalizedCandidate.length !== segments.length) {
      continue;
    }
    const key = normalizedCandidate.join("\u0000");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalizedCandidate);
  }
  return result;
}

function buildSimpleReturnAccessTemplate(rootTypeNames, index, options = {}) {
  const maxFieldsPerType = normalizeReturnMaxFieldsPerTypeValue(options.maxFieldsPerType, 0);
  const maxDepth = Math.max(1, Math.min(12, Number(options.maxDepth) || 2));
  const rootCollectionLike = Boolean(options.rootCollectionLike);
  const subtypePolicy = options.subtypePolicy;
  const rootTypePreferences = cloneTypePreferenceMap(options.typePreferencesByName);
  const dependencyFilePaths =
    options.dependencyFilePaths instanceof Set ? options.dependencyFilePaths : new Set();
  const levels = [];
  let currentNodes = [
    {
      segments: [],
      camelCaseSegmentPositions: new Set(),
      indexedSegmentPositions: new Set(),
      typeNames: uniqueStrings(rootTypeNames || []),
      typePreferencesByName: rootTypePreferences
    }
  ];

  for (let levelIndex = 1; levelIndex <= maxDepth && currentNodes.length > 0; levelIndex += 1) {
    const levelPathTemplatesBySignature = new Map();
    const nextNodesBySegments = new Map();

    for (const node of currentNodes) {
      const fields = collectDeclaredFieldsForTypes(node.typeNames, index, {
        typePreferencesByName: node.typePreferencesByName,
        includeProperties: options.includeProperties !== false
      }).slice(0, getEffectiveReturnMaxFieldsPerType(maxFieldsPerType));
      for (const field of fields) {
        addDependencyFilePath(dependencyFilePaths, field.sourceFilePath);
        const segments = node.segments.concat(field.name);
        const fieldResolutionContext = buildTypeResolutionContextFromSource(
          index,
          field.sourceFilePath,
          field.sourceModulePath,
          field.sourcePackagePath
        );
        const nestedTypeResolution = resolveIndexedTypesFromAnnotation(field.annotation, index, {
          policy: subtypePolicy,
          resolutionContext: fieldResolutionContext
        });
        const nestedTypeNames = nestedTypeResolution.typeNames;
        const camelCaseSegmentPositions = normalizeIndexedSegmentPositions(
          node.camelCaseSegmentPositions,
          segments.length
        );
        if (field.supportsCamelCaseAccess) {
          camelCaseSegmentPositions.add(segments.length - 1);
        }
        const indexedPositions = normalizeIndexedSegmentPositions(
          node.indexedSegmentPositions,
          segments.length
        );
        const normalizedCamelCaseSegmentPositions = [...camelCaseSegmentPositions].sort((left, right) => left - right);
        const normalizedIndexedPositions = [...indexedPositions].sort((left, right) => left - right);
        const pathTemplate = {
          includeRootIndexed: rootCollectionLike,
          segments,
          camelCaseSegmentPositions: normalizedCamelCaseSegmentPositions,
          indexedSegmentPositions: normalizedIndexedPositions,
          fieldAnnotation: String(field.annotation || "").trim(),
          fieldTypeNames: uniqueStrings(nestedTypeNames || []),
          fieldIsCollectionLike: Boolean(nestedTypeResolution.hasCollectionSubtype)
        };
        const pathSignature = `${rootCollectionLike ? "1" : "0"}|${segments.join("\u0000")}|${normalizedIndexedPositions.join(",")}`;
        if (!levelPathTemplatesBySignature.has(pathSignature)) {
          levelPathTemplatesBySignature.set(pathSignature, pathTemplate);
        } else {
          const existing = levelPathTemplatesBySignature.get(pathSignature);
          if (existing) {
            existing.camelCaseSegmentPositions = [
              ...normalizeIndexedSegmentPositions(
                [...(existing.camelCaseSegmentPositions || []), ...normalizedCamelCaseSegmentPositions],
                segments.length
              )
            ].sort((left, right) => left - right);
            existing.fieldIsCollectionLike =
              Boolean(existing.fieldIsCollectionLike) || Boolean(pathTemplate.fieldIsCollectionLike);
            existing.fieldTypeNames = uniqueStrings([...(existing.fieldTypeNames || []), ...pathTemplate.fieldTypeNames]);
            if (!existing.fieldAnnotation && pathTemplate.fieldAnnotation) {
              existing.fieldAnnotation = pathTemplate.fieldAnnotation;
            }
          }
        }

        if (levelIndex >= maxDepth) {
          continue;
        }
        if (nestedTypeNames.length === 0) {
          continue;
        }

        const segmentsKey = segments.join("\u0000");
        let nextNode = nextNodesBySegments.get(segmentsKey);
        if (!nextNode) {
          const nextCamelCaseSegmentPositions = new Set(node.camelCaseSegmentPositions || []);
          if (field.supportsCamelCaseAccess) {
            nextCamelCaseSegmentPositions.add(segments.length - 1);
          }
          const nextIndexedSegmentPositions = new Set(node.indexedSegmentPositions || []);
          if (nestedTypeResolution.hasCollectionSubtype) {
            nextIndexedSegmentPositions.add(segments.length - 1);
          }
          nextNode = {
            segments,
            camelCaseSegmentPositions: nextCamelCaseSegmentPositions,
            indexedSegmentPositions: nextIndexedSegmentPositions,
            typeNames: new Set(),
            typePreferencesByName: new Map()
          };
          mergeTypePreferenceMaps(nextNode.typePreferencesByName, node.typePreferencesByName);
          nextNodesBySegments.set(segmentsKey, nextNode);
        } else if (nestedTypeResolution.hasCollectionSubtype) {
          nextNode.indexedSegmentPositions.add(segments.length - 1);
        }
        if (field.supportsCamelCaseAccess) {
          nextNode.camelCaseSegmentPositions.add(segments.length - 1);
        }
        mergeTypePreferenceMaps(nextNode.typePreferencesByName, nestedTypeResolution.typePreferencesByName);
        for (const nestedTypeName of nestedTypeNames) {
          nextNode.typeNames.add(nestedTypeName);
        }
      }
    }

    levels.push([...levelPathTemplatesBySignature.values()]);
    currentNodes = [...nextNodesBySegments.values()].map((node) => ({
      segments: node.segments,
      camelCaseSegmentPositions: node.camelCaseSegmentPositions,
      indexedSegmentPositions: node.indexedSegmentPositions,
      typeNames: [...node.typeNames],
      typePreferencesByName: cloneTypePreferenceMap(node.typePreferencesByName)
    }));
  }

  return sanitizeSimpleAccessTemplate({
    levels,
    firstLevel: levels[0] || [],
    secondLevel: levels[1] || []
  });
}

function bindSimpleReturnAccessTemplate(variableToken, template, fieldNameStyle = "camelcase") {
  const baseVariableToken = getVariableRootToken(variableToken);
  const levels = Array.isArray(template?.levels) ? template.levels : [];
  const boundLevels = levels.map((levelTemplates) => {
    const boundPaths = [];
    for (const levelTemplate of Array.isArray(levelTemplates) ? levelTemplates : []) {
      const segmentVariants = buildVisibleTemplateSegmentVariants(levelTemplate, fieldNameStyle);
      for (const segments of segmentVariants) {
        const accessToken = buildRobotAttributeAccessTokenWithOptions(
          baseVariableToken,
          segments,
          {
            includeRootIndexed: Boolean(levelTemplate?.includeRootIndexed),
            indexedSegmentPositions: new Set(levelTemplate?.indexedSegmentPositions || [])
          }
        );
        if (!accessToken) {
          continue;
        }
        boundPaths.push(accessToken);
      }
    }
    return uniqueStrings(boundPaths);
  });

  return {
    firstLevel: boundLevels[0] || [],
    secondLevel: boundLevels[1] || [],
    levels: boundLevels
  };
}

function collectReturnMemberCompletionCandidatesFromTemplate(
  template,
  pathSegments,
  activeSegmentPrefix,
  completionMaxDepth,
  fieldNameStyle = "camelcase"
) {
  const normalizedPathSegments = sanitizeMemberPathSegments(pathSegments || []);
  const targetDepth = normalizedPathSegments.length + 1;
  const maxDepth = Math.max(1, Number(completionMaxDepth) || 1);
  if (targetDepth > maxDepth) {
    return [];
  }
  const levels = Array.isArray(template?.levels) ? template.levels : [];
  const levelTemplates = Array.isArray(levels[targetDepth - 1]) ? levels[targetDepth - 1] : [];
  const normalizedPrefix = normalizeMemberCompletionToken(activeSegmentPrefix).toLowerCase();
  const candidateMap = new Map();

  for (const levelTemplate of levelTemplates) {
    if (!isTemplatePathPrefixMatch(levelTemplate, normalizedPathSegments)) {
      continue;
    }
    const segmentName = String(levelTemplate?.segments?.[normalizedPathSegments.length] || "").trim();
    if (!segmentName) {
      continue;
    }
    const camelCaseSegmentPositions = normalizeIndexedSegmentPositions(
      levelTemplate?.camelCaseSegmentPositions || [],
      Array.isArray(levelTemplate?.segments) ? levelTemplate.segments.length : 0
    );
    const supportsCamelCaseAccess = camelCaseSegmentPositions.has(normalizedPathSegments.length);
    const visibleSegmentNames = getSegmentNameVariants(segmentName, supportsCamelCaseAccess, fieldNameStyle);
    const visibleInsertTexts = visibleSegmentNames.map((segmentVariant) =>
      levelTemplate?.fieldIsCollectionLike ? `${segmentVariant}[0]` : segmentVariant
    );
    const acceptedInsertTexts = getSegmentNameVariants(segmentName, supportsCamelCaseAccess, "both").map(
      (segmentVariant) => (levelTemplate?.fieldIsCollectionLike ? `${segmentVariant}[0]` : segmentVariant)
    );
    if (
      normalizedPrefix &&
      !acceptedInsertTexts.some((insertText) =>
        normalizeMemberCompletionToken(insertText).toLowerCase().startsWith(normalizedPrefix)
      )
    ) {
      continue;
    }
    const annotation = String(levelTemplate?.fieldAnnotation || "").trim();
    const typeDisplay = uniqueStrings(
      (Array.isArray(levelTemplate?.fieldTypeNames) ? levelTemplate.fieldTypeNames : [])
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    ).join(" | ");
    for (const insertText of visibleInsertTexts) {
      const normalizedInsertText = normalizeMemberCompletionToken(insertText).toLowerCase();
      let existing = candidateMap.get(normalizedInsertText);
      if (!existing) {
        existing = {
          label: insertText,
          insertText,
          sortText: normalizedInsertText,
          filterText: uniqueStrings([insertText, ...acceptedInsertTexts]).join(" "),
          detail: "",
          annotation: "",
          typeDisplay: ""
        };
        candidateMap.set(normalizedInsertText, existing);
      }
      if (annotation && !existing.annotation) {
        existing.annotation = annotation;
      }
      if (typeDisplay && !existing.typeDisplay) {
        existing.typeDisplay = typeDisplay;
      }
      if (!existing.detail) {
        existing.detail =
          existing.typeDisplay.length > 0
            ? existing.typeDisplay
            : annotation.length > 0
            ? annotation
            : "Return member";
      }
    }
  }

  return [...candidateMap.values()].sort((left, right) =>
    String(left.insertText || "").localeCompare(String(right.insertText || ""))
  );
}

function isTemplatePathPrefixMatch(levelTemplate, pathSegments) {
  const templateSegments = Array.isArray(levelTemplate?.segments) ? levelTemplate.segments : [];
  if (pathSegments.length > templateSegments.length) {
    return false;
  }

  const indexedSegmentPositions = new Set(levelTemplate?.indexedSegmentPositions || []);
  const camelCaseSegmentPositions = new Set(levelTemplate?.camelCaseSegmentPositions || []);
  for (let index = 0; index < pathSegments.length; index += 1) {
    const parsedTypedSegment = parseMemberPathSegment(pathSegments[index]);
    if (!parsedTypedSegment) {
      return false;
    }
    const matchingSegmentNames = getSegmentMatchVariants(
      templateSegments[index],
      camelCaseSegmentPositions.has(index)
    ).map((value) => normalizeComparableToken(value));
    if (!matchingSegmentNames.includes(parsedTypedSegment.normalizedName)) {
      return false;
    }
    if (parsedTypedSegment.indexed && !indexedSegmentPositions.has(index)) {
      return false;
    }
  }

  return true;
}

function sanitizeMemberPathSegments(pathSegments) {
  return (Array.isArray(pathSegments) ? pathSegments : [])
    .map((segment) => normalizeMemberPathSegment(segment))
    .filter(Boolean);
}

function normalizeMemberPathSegment(segment) {
  const normalized = normalizeMemberCompletionToken(segment);
  const match = normalized.match(/^([A-Za-z_][A-Za-z0-9_]*)(\[0\])?$/);
  if (!match) {
    return "";
  }
  return match[2] ? `${match[1]}[0]` : match[1];
}

function normalizeMemberCompletionToken(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/\[\s*\d+\s*\]/g, "[0]");
}

function normalizeDependencyFilePath(value) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/");
}

function addDependencyFilePath(targetSet, value) {
  if (!(targetSet instanceof Set)) {
    return;
  }
  const normalized = normalizeDependencyFilePath(value);
  if (!normalized) {
    return;
  }
  targetSet.add(normalized);
}

function parseMemberPathSegment(segment) {
  const normalized = normalizeMemberPathSegment(segment);
  if (!normalized) {
    return undefined;
  }
  const match = normalized.match(/^([A-Za-z_][A-Za-z0-9_]*)(\[0\])?$/);
  if (!match) {
    return undefined;
  }
  return {
    name: String(match[1] || ""),
    normalizedName: normalizeComparableToken(match[1] || ""),
    indexed: Boolean(match[2])
  };
}

function getTypePreviewCacheEntry(workspaceEntry, cacheKey) {
  if (!workspaceEntry || !(workspaceEntry.typePreviewCache instanceof Map) || !cacheKey) {
    return undefined;
  }
  const entry = workspaceEntry.typePreviewCache.get(cacheKey);
  if (!entry) {
    return undefined;
  }
  workspaceEntry.typePreviewCache.delete(cacheKey);
  workspaceEntry.typePreviewCache.set(cacheKey, entry);
  return entry;
}

function setTypePreviewCacheEntry(workspaceEntry, cacheKey, entry) {
  if (!workspaceEntry || !(workspaceEntry.typePreviewCache instanceof Map) || !cacheKey || !entry) {
    return;
  }
  const normalizedEntry = {
    simpleAccessTemplate: sanitizeSimpleAccessTemplate(entry.simpleAccessTemplate),
    technicalStructureLines: sanitizeTechnicalStructureLines(entry.technicalStructureLines),
    dependencyFilePaths: uniqueStrings(
      (Array.isArray(entry?.dependencyFilePaths) ? entry.dependencyFilePaths : [])
        .map((value) => normalizeDependencyFilePath(value))
        .filter(Boolean)
    )
  };
  if (workspaceEntry.typePreviewCache.has(cacheKey)) {
    deleteTypePreviewCacheEntry(workspaceEntry, cacheKey);
  }
  workspaceEntry.typePreviewCache.set(cacheKey, normalizedEntry);
  registerTypePreviewCacheDependencies(workspaceEntry, cacheKey, normalizedEntry.dependencyFilePaths);
  trimTypePreviewCache(workspaceEntry);
}

function trimTypePreviewCache(workspaceEntry) {
  if (!workspaceEntry || !(workspaceEntry.typePreviewCache instanceof Map)) {
    return;
  }
  const limit = clampTypeCacheMaxEntries(workspaceEntry.maxTypeCacheEntries);
  while (workspaceEntry.typePreviewCache.size > limit) {
    const firstKey = workspaceEntry.typePreviewCache.keys().next().value;
    deleteTypePreviewCacheEntry(workspaceEntry, firstKey);
  }
}

function deleteTypePreviewCacheEntry(workspaceEntry, cacheKey) {
  if (!workspaceEntry || !(workspaceEntry.typePreviewCache instanceof Map) || !cacheKey) {
    return false;
  }
  const existingEntry = workspaceEntry.typePreviewCache.get(cacheKey);
  if (!existingEntry) {
    return false;
  }
  unregisterTypePreviewCacheDependencies(workspaceEntry, cacheKey, existingEntry.dependencyFilePaths);
  workspaceEntry.typePreviewCache.delete(cacheKey);
  return true;
}

function registerTypePreviewCacheDependencies(workspaceEntry, cacheKey, dependencyFilePaths) {
  if (!workspaceEntry || !(workspaceEntry.typePreviewCacheKeysByFilePath instanceof Map) || !cacheKey) {
    return;
  }
  const normalizedDependencyPaths = uniqueStrings(
    (Array.isArray(dependencyFilePaths) ? dependencyFilePaths : [])
      .map((value) => normalizeDependencyFilePath(value))
      .filter(Boolean)
  );
  for (const filePath of normalizedDependencyPaths) {
    let keySet = workspaceEntry.typePreviewCacheKeysByFilePath.get(filePath);
    if (!keySet) {
      keySet = new Set();
      workspaceEntry.typePreviewCacheKeysByFilePath.set(filePath, keySet);
    }
    keySet.add(cacheKey);
  }
}

function unregisterTypePreviewCacheDependencies(workspaceEntry, cacheKey, dependencyFilePaths) {
  if (!workspaceEntry || !(workspaceEntry.typePreviewCacheKeysByFilePath instanceof Map) || !cacheKey) {
    return;
  }
  const normalizedDependencyPaths = uniqueStrings(
    (Array.isArray(dependencyFilePaths) ? dependencyFilePaths : [])
      .map((value) => normalizeDependencyFilePath(value))
      .filter(Boolean)
  );
  for (const filePath of normalizedDependencyPaths) {
    const keySet = workspaceEntry.typePreviewCacheKeysByFilePath.get(filePath);
    if (!keySet) {
      continue;
    }
    keySet.delete(cacheKey);
    if (keySet.size === 0) {
      workspaceEntry.typePreviewCacheKeysByFilePath.delete(filePath);
    }
  }
}

function clampTypeCacheMaxEntries(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return TYPE_PREVIEW_CACHE_MAX_ENTRIES_DEFAULT;
  }
  return Math.max(50, Math.min(5000, Math.round(numericValue)));
}

function serializeTypePreferenceMapEntries(typePreferencesByName) {
  if (!(typePreferencesByName instanceof Map)) {
    return [];
  }
  const entries = [];
  for (const [typeName, qualifiedNames] of typePreferencesByName.entries()) {
    const normalizedTypeName = normalizeComparableToken(typeName);
    if (!normalizedTypeName) {
      continue;
    }
    const normalizedQualifiedNames = uniqueStrings(
      (qualifiedNames || []).map((value) => normalizeQualifiedTypeName(value)).filter(Boolean)
    );
    entries.push([normalizedTypeName, normalizedQualifiedNames]);
  }
  entries.sort((left, right) => String(left[0] || "").localeCompare(String(right[0] || "")));
  return entries;
}

function sanitizePersistedTypeCacheEntries(entries) {
  const sanitized = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const cacheKey = String(entry?.key || "");
    const sanitizedEntry = sanitizeTypePreviewCacheEntry(entry?.entry);
    if (!cacheKey || !sanitizedEntry) {
      continue;
    }
    sanitized.push({
      key: cacheKey,
      entry: sanitizedEntry
    });
  }
  return sanitized;
}

function serializeTypePreviewCacheEntry(entry) {
  const sanitizedEntry = sanitizeTypePreviewCacheEntry(entry);
  if (!sanitizedEntry) {
    return undefined;
  }
  return sanitizedEntry;
}

function sanitizeTypePreviewCacheEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return undefined;
  }
  return {
    simpleAccessTemplate: sanitizeSimpleAccessTemplate(entry.simpleAccessTemplate),
    technicalStructureLines: sanitizeTechnicalStructureLines(entry.technicalStructureLines),
    dependencyFilePaths: uniqueStrings(
      (Array.isArray(entry?.dependencyFilePaths) ? entry.dependencyFilePaths : [])
        .map((value) => normalizeDependencyFilePath(value))
        .filter(Boolean)
    )
  };
}

function sanitizeSimpleAccessTemplate(template) {
  const levels = (template?.levels || []).map((levelTemplates) =>
    (Array.isArray(levelTemplates) ? levelTemplates : [])
      .map((levelTemplate) => {
        const segments = (levelTemplate?.segments || [])
          .map((value) => String(value || "").trim())
          .filter(Boolean);
        if (segments.length === 0) {
          return undefined;
        }
        const indexedSegmentPositions = normalizeIndexedSegmentPositions(
          levelTemplate?.indexedSegmentPositions || [],
          segments.length
        );
        const camelCaseSegmentPositions = normalizeIndexedSegmentPositions(
          levelTemplate?.camelCaseSegmentPositions || [],
          segments.length
        );
        return {
          includeRootIndexed: Boolean(levelTemplate?.includeRootIndexed),
          segments,
          camelCaseSegmentPositions: [...camelCaseSegmentPositions].sort((left, right) => left - right),
          indexedSegmentPositions: [...indexedSegmentPositions].sort((left, right) => left - right),
          fieldAnnotation: String(levelTemplate?.fieldAnnotation || ""),
          fieldTypeNames: uniqueStrings(
            (Array.isArray(levelTemplate?.fieldTypeNames) ? levelTemplate.fieldTypeNames : [])
              .map((value) => String(value || "").trim())
              .filter(Boolean)
          ),
          fieldIsCollectionLike: Boolean(levelTemplate?.fieldIsCollectionLike)
        };
      })
      .filter(Boolean)
  );
  return {
    levels,
    firstLevel: levels[0] || [],
    secondLevel: levels[1] || []
  };
}

function sanitizeTechnicalStructureLines(lines) {
  return (Array.isArray(lines) ? lines : []).map((value) => String(value || ""));
}

function hydrateTypePreferenceMap(entries) {
  const map = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const key = normalizeComparableToken(entry?.[0]);
    if (!key) {
      continue;
    }
    const values = uniqueStrings((entry?.[1] || []).map((value) => normalizeQualifiedTypeName(value)).filter(Boolean));
    map.set(key, values);
  }
  return map;
}

function hydrateSubtypePolicy(rawPolicy) {
  return {
    mode: String(rawPolicy?.mode || "always").trim().toLowerCase(),
    includeSet: new Set((rawPolicy?.includeSet || []).map((value) => normalizeComparableToken(value)).filter(Boolean)),
    excludeSet: new Set((rawPolicy?.excludeSet || []).map((value) => normalizeComparableToken(value)).filter(Boolean)),
    collectionContainers: new Set(
      (rawPolicy?.collectionContainers || []).map((value) => normalizeComparableToken(value)).filter(Boolean)
    )
  };
}

function buildSimpleReturnAccessPaths(variableToken, rootTypeNames, index, options = {}) {
  const template = buildSimpleReturnAccessTemplate(rootTypeNames, index, options);
  return bindSimpleReturnAccessTemplate(variableToken, template, options.fieldNameStyle);
}

function buildReturnStructureLines(rootTypeNames, index, options, mode = "simple") {
  if (!Array.isArray(rootTypeNames) || rootTypeNames.length === 0) {
    return [];
  }

  const normalizedMode = mode === "technical" ? "technical" : "simple";
  const maxDepth = Math.max(0, Number(options.maxDepth) || 0);
  const maxFieldsPerType = normalizeReturnMaxFieldsPerTypeValue(options.maxFieldsPerType, 0);
  const typePreferencesByName = cloneTypePreferenceMap(options.typePreferencesByName);
  const subtypePolicy = options.subtypePolicy;
  const dependencyFilePaths =
    options?.dependencyFilePaths instanceof Set ? options.dependencyFilePaths : new Set();
  const lines = [];

  for (let indexOfType = 0; indexOfType < rootTypeNames.length; indexOfType += 1) {
    const typeName = rootTypeNames[indexOfType];
    if (indexOfType > 0) {
      lines.push("");
    }
    lines.push(
      ...renderIndexedTypeTree(typeName, index, 0, maxDepth, maxFieldsPerType, new Set(), normalizedMode, {
        typePreferencesByName,
        subtypePolicy,
        includeProperties: options.includeProperties !== false,
        dependencyFilePaths
      })
    );
  }

  return lines;
}

function normalizeStructuredTypeSpecifier(typeSpecifier) {
  if (typeof typeSpecifier === "string") {
    const typeName = String(typeSpecifier || "").trim();
    if (!typeName) {
      return undefined;
    }
    return {
      typeName,
      displayName: typeName,
      preferredQualifiedNames: []
    };
  }

  const typeName = String(typeSpecifier?.typeName || "").trim();
  if (!typeName) {
    return undefined;
  }

  return {
    typeName,
    displayName: String(typeSpecifier?.displayName || typeName).trim() || typeName,
    preferredQualifiedNames: uniqueStrings(
      (Array.isArray(typeSpecifier?.preferredQualifiedNames) ? typeSpecifier.preferredQualifiedNames : [])
        .map((value) => normalizeQualifiedTypeName(value))
        .filter(Boolean)
    )
  };
}

function getStructuredTypeVisitedKey(typeName, selectedType, preferredQualifiedNames = []) {
  const selectedQualifiedName = normalizeQualifiedTypeName(selectedType?.qualifiedName || "");
  if (selectedQualifiedName) {
    return selectedQualifiedName;
  }
  const preferredQualifiedName = normalizeQualifiedTypeName(preferredQualifiedNames[0] || "");
  if (preferredQualifiedName) {
    return preferredQualifiedName;
  }
  return normalizeComparableToken(typeName);
}

function resolveInheritedStructuredTypeSpecifiers(selectedType, index) {
  const explicitRefs =
    Array.isArray(selectedType?.baseTypeRefs) && selectedType.baseTypeRefs.length > 0
      ? selectedType.baseTypeRefs
      : uniqueStrings((selectedType?.baseTypeNames || []).map((value) => String(value || "").trim())).map(
          (typeName) => ({
            typeName,
            preferredQualifiedNames: []
          })
        );
  const resolvedRefs = [];
  const seenRefs = new Set();

  for (const baseTypeRef of explicitRefs) {
    const normalizedRef = normalizeStructuredTypeSpecifier(baseTypeRef);
    if (!normalizedRef) {
      continue;
    }
    const structuredTypeCandidates = index?.structuredTypesByName?.get(normalizedRef.typeName) || [];
    const matchingCandidates =
      normalizedRef.preferredQualifiedNames.length > 0
        ? structuredTypeCandidates.filter((candidate) =>
            normalizedRef.preferredQualifiedNames.includes(normalizeQualifiedTypeName(candidate?.qualifiedName || ""))
          )
        : structuredTypeCandidates;
    const usableCandidates = matchingCandidates.length > 0 ? matchingCandidates : structuredTypeCandidates;
    if (!usableCandidates.some((candidate) => candidate?.isDataclass)) {
      continue;
    }
    const key = JSON.stringify({
      typeName: normalizeComparableToken(normalizedRef.typeName),
      preferredQualifiedNames: normalizedRef.preferredQualifiedNames
    });
    if (seenRefs.has(key)) {
      continue;
    }
    seenRefs.add(key);
    resolvedRefs.push(normalizedRef);
  }

  return resolvedRefs;
}

function renderIndexedTypeTree(typeSpecifier, index, depth, maxDepth, maxFieldsPerType, visited, mode, options = {}) {
  const normalizedMode = mode === "technical" ? "technical" : "simple";
  const typePreferencesByName = options.typePreferencesByName instanceof Map ? options.typePreferencesByName : new Map();
  const subtypePolicy = options.subtypePolicy;
  const dependencyFilePaths =
    options.dependencyFilePaths instanceof Set ? options.dependencyFilePaths : new Set();
  const effectiveMaxFieldsPerType = getEffectiveReturnMaxFieldsPerType(maxFieldsPerType);
  const normalizedSpecifier = normalizeStructuredTypeSpecifier(typeSpecifier);
  if (!normalizedSpecifier) {
    return [];
  }
  const typeName = normalizedSpecifier.typeName;
  const normalizedTypeName = normalizeComparableToken(typeName);
  const indent = "  ".repeat(depth);
  const preferredQualifiedNames =
    normalizedSpecifier.preferredQualifiedNames.length > 0
      ? normalizedSpecifier.preferredQualifiedNames
      : getPreferredQualifiedNamesForType(typePreferencesByName, typeName);
  const enumCandidates = index.enumsByName?.get(typeName) || [];
  if (enumCandidates.length > 0) {
    const selectedEnum = choosePreferredEnumDefinition(enumCandidates, {
      preferredQualifiedNames
    });
    if (!selectedEnum) {
      return [`${indent}${typeName} (enum)`];
    }
    addDependencyFilePath(dependencyFilePaths, selectedEnum.filePath);
    const lines = [`${indent}${typeName} (enum)`];
    const members = selectedEnum.members || [];
    const shownMembers = members.slice(0, Math.min(effectiveMaxFieldsPerType, 15));
    for (const member of shownMembers) {
      lines.push(
        normalizedMode === "technical"
          ? `${indent}  - ${formatEnumMemberForDisplay(member)}`
          : `${indent}  - ${member.name || formatEnumMemberForDisplay(member)}`
      );
    }
    if (members.length > shownMembers.length) {
      lines.push(`${indent}  ... ${members.length - shownMembers.length} more enum members`);
    }
    return lines;
  }

  const structuredTypeCandidates = index.structuredTypesByName?.get(typeName) || [];
  if (structuredTypeCandidates.length === 0) {
    return [`${indent}${typeName}`];
  }

  const selectedType = choosePreferredStructuredTypeDefinition(structuredTypeCandidates, {
    preferredQualifiedNames
  });
  if (!selectedType) {
    return [`${indent}${typeName}`];
  }
  const visitedKey = getStructuredTypeVisitedKey(typeName, selectedType, preferredQualifiedNames);
  if (visited.has(visitedKey)) {
    return [`${indent}${normalizedSpecifier.displayName} (recursive)`];
  }
  addDependencyFilePath(dependencyFilePaths, selectedType.filePath);
  const typeLabel =
    normalizedMode === "technical"
      ? `${normalizedSpecifier.displayName} (${selectedType.isDataclass ? "dataclass" : "typed class"})`
      : normalizedSpecifier.displayName;
  const lines = [`${indent}${typeLabel}`];

  const nextVisited = new Set(visited);
  nextVisited.add(visitedKey);

  const fields = getStructuredTypeDeclaredMembers(selectedType, options);
  const shownFields = fields.slice(0, effectiveMaxFieldsPerType);
  for (const field of shownFields) {
    lines.push(normalizedMode === "technical" ? `${indent}  .${field.name}` : `${indent}  - ${field.name}`);
    if (depth >= maxDepth) {
      continue;
    }

    const selectedTypeResolutionContext = buildTypeResolutionContextFromStructuredType(index, selectedType);
    const nestedTypeResolution = resolveIndexedTypesFromAnnotation(field.annotation, index, {
      policy: subtypePolicy,
      resolutionContext: selectedTypeResolutionContext
    });
    const nestedTypePreferences = cloneTypePreferenceMap(typePreferencesByName);
    mergeTypePreferenceMaps(nestedTypePreferences, nestedTypeResolution.typePreferencesByName);
    const nestedTypes = uniqueStrings(
      nestedTypeResolution.typeNames.filter(
        (nestedTypeName) => normalizeComparableToken(nestedTypeName) !== normalizedTypeName
      )
    );
    const shownNestedTypes = nestedTypes.slice(0, 2);
    for (const nestedTypeName of shownNestedTypes) {
      lines.push(
        ...renderIndexedTypeTree(
          {
            typeName: nestedTypeName,
            displayName: nestedTypeName
          },
          index,
          depth + 1,
          maxDepth,
          maxFieldsPerType,
          nextVisited,
          normalizedMode,
          {
            typePreferencesByName: nestedTypePreferences,
            subtypePolicy,
            includeProperties: options.includeProperties !== false,
            dependencyFilePaths
          }
        )
      );
    }
  }

  if (fields.length > shownFields.length) {
    lines.push(`${indent}  ... ${fields.length - shownFields.length} more fields`);
  }

  const inheritedTypeSpecifiers = resolveInheritedStructuredTypeSpecifiers(selectedType, index).filter(
    (inheritedTypeSpecifier) =>
      getStructuredTypeVisitedKey(
        inheritedTypeSpecifier.typeName,
        undefined,
        inheritedTypeSpecifier.preferredQualifiedNames
      ) !== visitedKey
  );
  if (inheritedTypeSpecifiers.length > 0) {
    if (depth >= maxDepth) {
      lines.push(
        normalizedMode === "technical"
          ? `${indent}  [inherits] ${inheritedTypeSpecifiers
              .map((inheritedTypeSpecifier) => inheritedTypeSpecifier.displayName)
              .join(", ")}`
          : `${indent}  inherits: ${inheritedTypeSpecifiers
              .map((inheritedTypeSpecifier) => inheritedTypeSpecifier.displayName)
              .join(", ")}`
      );
    } else {
      lines.push(normalizedMode === "technical" ? `${indent}  [inherits]` : `${indent}  inherits`);
      const shownInheritedTypeSpecifiers = inheritedTypeSpecifiers.slice(0, 5);
      for (const inheritedTypeSpecifier of shownInheritedTypeSpecifiers) {
        lines.push(
          ...renderIndexedTypeTree(
            inheritedTypeSpecifier,
            index,
            depth + 1,
            maxDepth,
            maxFieldsPerType,
            nextVisited,
            normalizedMode,
          {
            typePreferencesByName,
            subtypePolicy,
            includeProperties: options.includeProperties !== false,
            dependencyFilePaths
          }
        )
      );
      }
      if (inheritedTypeSpecifiers.length > shownInheritedTypeSpecifiers.length) {
        lines.push(
          `${indent}  ... ${inheritedTypeSpecifiers.length - shownInheritedTypeSpecifiers.length} more inherited types`
        );
      }
    }
  }

  return lines;
}

function collectDeclaredFieldsForTypes(typeNames, index, options = {}) {
  const combinedFields = [];
  for (const typeName of uniqueStrings(typeNames || [])) {
    combinedFields.push(
      ...collectDeclaredFieldsForType(
        {
          typeName,
          displayName: typeName
        },
        index,
        new Set(),
        options
      )
    );
  }
  return dedupeFieldDescriptorsByName(combinedFields);
}

function getStructuredTypeDeclaredMembers(structuredType, options = {}) {
  const fields = Array.isArray(structuredType?.fields) ? structuredType.fields : [];
  const properties =
    options.includeProperties === false || !Array.isArray(structuredType?.properties)
      ? []
      : structuredType.properties;
  return dedupeStructuredFields(fields.concat(properties));
}

function collectDeclaredFieldsForType(typeSpecifier, index, visited, options = {}) {
  const normalizedSpecifier = normalizeStructuredTypeSpecifier(typeSpecifier);
  if (!normalizedSpecifier) {
    return [];
  }
  const typeName = normalizedSpecifier.typeName;
  const normalizedTypeName = normalizeComparableToken(typeName);

  const structuredTypeCandidates = index.structuredTypesByName?.get(typeName) || [];
  if (structuredTypeCandidates.length === 0) {
    return [];
  }

  const preferredQualifiedNames =
    normalizedSpecifier.preferredQualifiedNames.length > 0
      ? normalizedSpecifier.preferredQualifiedNames
      : getPreferredQualifiedNamesForType(options.typePreferencesByName, typeName);
  const selectedType = choosePreferredStructuredTypeDefinition(structuredTypeCandidates, {
    preferredQualifiedNames
  });
  if (!selectedType) {
    return [];
  }
  const fieldAccessSupportsCamelCase =
    typeof options.fieldAccessSupportsCamelCase === "boolean"
      ? options.fieldAccessSupportsCamelCase
      : Boolean(selectedType.supportsCamelCaseAccess);
  const visitedKey = getStructuredTypeVisitedKey(typeName, selectedType, preferredQualifiedNames);
  if (visited.has(visitedKey) || visited.has(normalizedTypeName)) {
    return [];
  }
  const nextVisited = new Set(visited);
  nextVisited.add(visitedKey);

  const sourceFilePath = String(selectedType.filePath || "");
  const sourceModulePath = String(selectedType.modulePath || "");
  const sourcePackagePath = String(index?.moduleInfoByFile?.get(sourceFilePath)?.packagePath || "");
  const fields = getStructuredTypeDeclaredMembers(selectedType, options)
    .filter((field) => !SIMPLE_RETURN_IGNORED_FIELD_NAMES.has(normalizeComparableToken(field.name)))
    .map((field) => ({
      ...field,
      supportsCamelCaseAccess: fieldAccessSupportsCamelCase,
      sourceFilePath,
      sourceModulePath,
      sourcePackagePath
    }));

  const inheritedFields = [];
  for (const inheritedTypeSpecifier of resolveInheritedStructuredTypeSpecifiers(selectedType, index)) {
    const inheritedVisitedKey = getStructuredTypeVisitedKey(
      inheritedTypeSpecifier.typeName,
      undefined,
      inheritedTypeSpecifier.preferredQualifiedNames
    );
    if (inheritedVisitedKey === visitedKey) {
      continue;
    }
    inheritedFields.push(
      ...collectDeclaredFieldsForType(inheritedTypeSpecifier, index, nextVisited, {
        ...options,
        fieldAccessSupportsCamelCase
      })
    );
  }

  return dedupeFieldDescriptorsByName(fields.concat(inheritedFields));
}

function resolveIndexedTypesFromAnnotation(annotation, index, options = {}) {
  if (!annotation || !index) {
    return {
      typeNames: [],
      hasCollectionSubtype: false,
      containerNames: [],
      typePreferencesByName: new Map()
    };
  }

  const nodes = parseTypeAnnotationNodes(annotation);
  if (nodes.length === 0) {
    return {
      typeNames: [],
      hasCollectionSubtype: false,
      containerNames: [],
      typePreferencesByName: new Map()
    };
  }

  const policy = options.policy;
  const resolutionContext = options.resolutionContext;
  const typeNames = [];
  const containerNames = new Set();
  const typePreferencesByName = new Map();
  let hasCollectionSubtype = false;

  const visitNode = (node, insideCollectionContainer = false) => {
    if (!node) {
      return;
    }

    if (node.kind === "union" || node.kind === "tuple") {
      for (const item of node.items || []) {
        visitNode(item, insideCollectionContainer);
      }
      return;
    }

    if (node.kind !== "name") {
      return;
    }

    const resolvedType = resolveIndexedTypeReference(node.name, index, resolutionContext);
    if (resolvedType) {
      typeNames.push(resolvedType.simpleName);
      if (resolvedType.preferredQualifiedNames.length > 0) {
        mergeTypePreferenceMap(typePreferencesByName, resolvedType.simpleName, resolvedType.preferredQualifiedNames);
      }
      if (insideCollectionContainer) {
        hasCollectionSubtype = true;
      }
    }

    const args = Array.isArray(node.args) ? node.args : [];
    if (args.length === 0) {
      return;
    }

    const nodeName = extractTypeSimpleName(node.name);
    const normalizedContainerName = normalizeComparableToken(nodeName);
    if (!shouldResolveSubtypeFromContainer(normalizedContainerName, policy)) {
      return;
    }

    containerNames.add(normalizedContainerName);
    const insideChildCollectionContainer =
      insideCollectionContainer || policy.collectionContainers.has(normalizedContainerName);
    for (const argNode of args) {
      visitNode(argNode, insideChildCollectionContainer);
    }
  };

  for (const rootNode of nodes) {
    visitNode(rootNode, false);
  }

  return {
    typeNames: uniqueStrings(typeNames),
    hasCollectionSubtype,
    containerNames: [...containerNames],
    typePreferencesByName
  };
}

function resolveIndexedTypeReference(typeToken, index, resolutionContext) {
  const rawTypeName = String(typeToken || "").trim();
  if (!rawTypeName) {
    return undefined;
  }

  const simpleName = extractTypeSimpleName(rawTypeName);
  if (!simpleName) {
    return undefined;
  }

  const preferredQualifiedNames = [];
  const addPreferredQualifiedName = (qualifiedName) => {
    const normalizedQualifiedName = normalizeQualifiedTypeName(qualifiedName);
    if (!normalizedQualifiedName) {
      return;
    }
    if (!hasIndexedTypeForQualifiedName(index, normalizedQualifiedName)) {
      return;
    }
    preferredQualifiedNames.push(normalizedQualifiedName);
  };

  if (resolutionContext) {
    addPreferredQualifiedName(rawTypeName);

    const dottedMatch = rawTypeName.match(/^([A-Za-z_][A-Za-z0-9_]*)\.(.+)$/);
    if (dottedMatch) {
      const moduleAlias = String(dottedMatch[1] || "").trim();
      const remainder = String(dottedMatch[2] || "").trim();
      const modulePath = String(resolutionContext.moduleImportAliases?.get(moduleAlias) || "").trim();
      if (modulePath && remainder) {
        addPreferredQualifiedName(`${modulePath}.${remainder}`);
        addPreferredQualifiedName(`${modulePath}.${extractTypeSimpleName(remainder)}`);
      }
      const aliasImports = resolutionContext.typeImportAliases?.get(moduleAlias) || [];
      for (const importSpec of aliasImports) {
        const importModulePath = String(importSpec?.modulePath || "").trim();
        const importSymbolName = String(importSpec?.symbolName || "").trim();
        if (!importModulePath || !importSymbolName || !remainder) {
          continue;
        }
        addPreferredQualifiedName(`${importModulePath}.${importSymbolName}.${remainder}`);
        addPreferredQualifiedName(
          `${importModulePath}.${importSymbolName}.${extractTypeSimpleName(remainder)}`
        );
      }
    }

    const directImports = []
      .concat(resolutionContext.typeImportAliases?.get(rawTypeName) || [])
      .concat(resolutionContext.typeImportAliases?.get(simpleName) || []);
    for (const importSpec of directImports) {
      addPreferredQualifiedName(
        `${String(importSpec.modulePath || "").trim()}.${String(importSpec.symbolName || "").trim()}`
      );
    }

    const isLocalStructuredType = resolutionContext.localStructuredTypeNames?.has(simpleName);
    const isLocalEnumType = resolutionContext.localEnumNames?.has(simpleName);
    if ((isLocalStructuredType || isLocalEnumType) && resolutionContext.modulePath) {
      addPreferredQualifiedName(`${resolutionContext.modulePath}.${simpleName}`);
    }
  }

  const dedupedPreferredQualifiedNames = uniqueStrings(preferredQualifiedNames);
  if (dedupedPreferredQualifiedNames.length > 0) {
    return {
      simpleName,
      preferredQualifiedNames: dedupedPreferredQualifiedNames
    };
  }

  if (!hasIndexedTypeForName(index, simpleName)) {
    return undefined;
  }

  return {
    simpleName,
    preferredQualifiedNames: []
  };
}

function buildTypeResolutionContextFromSource(index, sourceFilePath, fallbackModulePath = "", fallbackPackagePath = "") {
  const normalizedSourceFilePath = String(sourceFilePath || "").trim();
  const moduleInfo = normalizedSourceFilePath ? index?.moduleInfoByFile?.get(normalizedSourceFilePath) : undefined;
  const modulePath = String(fallbackModulePath || moduleInfo?.modulePath || "").trim();
  const packagePath = String(fallbackPackagePath || moduleInfo?.packagePath || "").trim();
  const localStructuredTypeNames = normalizedSourceFilePath
    ? new Set(index?.localStructuredTypeNamesByFile?.get(normalizedSourceFilePath) || [])
    : new Set();
  const localEnumNames = normalizedSourceFilePath
    ? new Set(index?.localEnumNamesByFile?.get(normalizedSourceFilePath) || [])
    : new Set();
  const typeImportAliases = normalizedSourceFilePath
    ? cloneTypeImportAliasesMap(index?.typeImportAliasesByFile?.get(normalizedSourceFilePath))
    : new Map();
  const moduleImportAliases = normalizedSourceFilePath
    ? new Map(index?.moduleImportAliasesByFile?.get(normalizedSourceFilePath) || [])
    : new Map();

  return {
    sourceFilePath: normalizedSourceFilePath,
    modulePath,
    packagePath,
    localStructuredTypeNames,
    localEnumNames,
    typeImportAliases,
    moduleImportAliases
  };
}

function buildTypeResolutionContextFromStructuredType(index, structuredType) {
  if (!structuredType) {
    return undefined;
  }
  return buildTypeResolutionContextFromSource(index, structuredType.filePath, structuredType.modulePath, "");
}

function cloneTypeImportAliasesMap(sourceMap) {
  const cloned = new Map();
  if (!(sourceMap instanceof Map)) {
    return cloned;
  }
  for (const [key, specs] of sourceMap.entries()) {
    cloned.set(
      String(key || ""),
      (Array.isArray(specs) ? specs : []).map((spec) => ({
        modulePath: String(spec?.modulePath || ""),
        symbolName: String(spec?.symbolName || "")
      }))
    );
  }
  return cloned;
}

function shouldResolveSubtypeFromContainer(normalizedContainerName, policy) {
  if (!normalizedContainerName || !policy) {
    return false;
  }

  if (policy.mode === "never") {
    return false;
  }
  if (policy.mode === "always") {
    return true;
  }
  if (policy.mode === "exclude") {
    return !policy.excludeSet.has(normalizedContainerName);
  }

  if (policy.includeSet.size > 0) {
    return policy.includeSet.has(normalizedContainerName);
  }
  return policy.collectionContainers.has(normalizedContainerName);
}

function getVariableRootToken(variableToken) {
  const source = String(variableToken || "").trim();
  const match = source.match(/^([@$&%]\{)([^}\r\n]+)\}$/);
  if (!match) {
    return source;
  }

  const prefix = match[1];
  const body = match[2].trim();
  if (!body) {
    return source;
  }

  const root = body.split(/[.\[]/, 1)[0].trim();
  if (!root) {
    return source;
  }

  return `${prefix}${root}}`;
}

function buildRobotAttributeAccessTokenWithOptions(baseVariableToken, segments, options = {}) {
  const match = String(baseVariableToken || "").match(/^([@$&%])\{([^}\r\n]+)\}$/);
  if (!match) {
    return "";
  }

  const normalizedSegments = (segments || []).map((segment) => String(segment || "").trim()).filter(Boolean);
  if (normalizedSegments.length === 0) {
    return "";
  }

  const indexedSegmentPositions = normalizeIndexedSegmentPositions(
    options.indexedSegmentPositions,
    normalizedSegments.length
  );
  const normalizedPathSegments = normalizedSegments.map((segment, index) =>
    indexedSegmentPositions.has(index) ? `${segment}[0]` : segment
  );
  const rootBody = options.includeRootIndexed ? `${match[2]}[0]` : match[2];
  return `${match[1]}{${rootBody}.${normalizedPathSegments.join(".")}}`;
}

function normalizeIndexedSegmentPositions(rawIndexedPositions, segmentCount) {
  const normalized = new Set();
  const values = rawIndexedPositions instanceof Set ? [...rawIndexedPositions] : rawIndexedPositions || [];
  for (const value of values) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
      continue;
    }
    const index = Math.trunc(numericValue);
    if (index < 0 || index >= segmentCount) {
      continue;
    }
    normalized.add(index);
  }
  return normalized;
}

function choosePreferredStructuredTypeDefinition(candidates, options = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return undefined;
  }

  const preferredQualifiedNames = uniqueStrings(options.preferredQualifiedNames || []).map(
    normalizeQualifiedTypeName
  );
  const sorted = [...candidates].sort((left, right) => {
    const leftPreferenceRank = getQualifiedNamePreferenceRank(left, preferredQualifiedNames);
    const rightPreferenceRank = getQualifiedNamePreferenceRank(right, preferredQualifiedNames);
    if (leftPreferenceRank !== rightPreferenceRank) {
      return leftPreferenceRank - rightPreferenceRank;
    }

    const leftDataclassScore = left.isDataclass ? 1 : 0;
    const rightDataclassScore = right.isDataclass ? 1 : 0;
    if (leftDataclassScore !== rightDataclassScore) {
      return rightDataclassScore - leftDataclassScore;
    }

    const leftFieldCount = getStructuredTypeMemberCount(left);
    const rightFieldCount = getStructuredTypeMemberCount(right);
    if (leftFieldCount !== rightFieldCount) {
      return rightFieldCount - leftFieldCount;
    }

    const leftQualifiedName = normalizeQualifiedTypeName(left.qualifiedName);
    const rightQualifiedName = normalizeQualifiedTypeName(right.qualifiedName);
    return leftQualifiedName.localeCompare(rightQualifiedName);
  });
  return sorted[0];
}

function getStructuredTypeMemberCount(structuredType) {
  const fieldCount = Array.isArray(structuredType?.fields) ? structuredType.fields.length : 0;
  const propertyCount = Array.isArray(structuredType?.properties) ? structuredType.properties.length : 0;
  return fieldCount + propertyCount;
}

function choosePreferredEnumDefinition(candidates, options = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return undefined;
  }

  const preferredQualifiedNames = uniqueStrings(options.preferredQualifiedNames || []).map(
    normalizeQualifiedTypeName
  );
  const sorted = [...candidates].sort((left, right) => {
    const leftPreferenceRank = getQualifiedNamePreferenceRank(left, preferredQualifiedNames);
    const rightPreferenceRank = getQualifiedNamePreferenceRank(right, preferredQualifiedNames);
    if (leftPreferenceRank !== rightPreferenceRank) {
      return leftPreferenceRank - rightPreferenceRank;
    }

    const leftMembers = Array.isArray(left.members) ? left.members.length : 0;
    const rightMembers = Array.isArray(right.members) ? right.members.length : 0;
    if (leftMembers !== rightMembers) {
      return rightMembers - leftMembers;
    }

    const leftQualifiedName = normalizeQualifiedTypeName(left.qualifiedName);
    const rightQualifiedName = normalizeQualifiedTypeName(right.qualifiedName);
    return leftQualifiedName.localeCompare(rightQualifiedName);
  });
  return sorted[0];
}

function getQualifiedNamePreferenceRank(candidate, preferredQualifiedNames) {
  const normalizedQualifiedName = normalizeQualifiedTypeName(candidate?.qualifiedName || "");
  if (!normalizedQualifiedName || !Array.isArray(preferredQualifiedNames) || preferredQualifiedNames.length === 0) {
    return Number.MAX_SAFE_INTEGER;
  }
  const index = preferredQualifiedNames.indexOf(normalizedQualifiedName);
  return index >= 0 ? index : Number.MAX_SAFE_INTEGER;
}

function getPreferredQualifiedNamesForType(typePreferencesByName, typeName) {
  if (!(typePreferencesByName instanceof Map)) {
    return [];
  }
  const normalizedTypeName = normalizeComparableToken(typeName);
  if (!normalizedTypeName) {
    return [];
  }
  return uniqueStrings(
    (typePreferencesByName.get(normalizedTypeName) || [])
      .map((value) => normalizeQualifiedTypeName(value))
      .filter(Boolean)
  );
}

function mergeTypePreferenceMap(targetMap, typeName, qualifiedNames) {
  if (!(targetMap instanceof Map)) {
    return;
  }

  const normalizedTypeName = normalizeComparableToken(typeName);
  if (!normalizedTypeName) {
    return;
  }

  const normalizedQualifiedNames = (qualifiedNames || [])
    .map((value) => normalizeQualifiedTypeName(value))
    .filter(Boolean);
  if (normalizedQualifiedNames.length === 0) {
    return;
  }
  const existing = targetMap.get(normalizedTypeName) || [];
  targetMap.set(normalizedTypeName, uniqueStrings(existing.concat(normalizedQualifiedNames)));
}

function cloneTypePreferenceMap(sourceMap) {
  const cloned = new Map();
  if (!(sourceMap instanceof Map)) {
    return cloned;
  }
  for (const [typeName, qualifiedNames] of sourceMap.entries()) {
    const normalizedTypeName = normalizeComparableToken(typeName);
    if (!normalizedTypeName) {
      continue;
    }
    const normalizedQualifiedNames = (qualifiedNames || [])
      .map((value) => normalizeQualifiedTypeName(value))
      .filter(Boolean);
    if (normalizedQualifiedNames.length > 0) {
      cloned.set(normalizedTypeName, uniqueStrings(normalizedQualifiedNames));
    }
  }
  return cloned;
}

function mergeTypePreferenceMaps(targetMap, sourceMap) {
  if (!(targetMap instanceof Map) || !(sourceMap instanceof Map)) {
    return targetMap;
  }
  for (const [typeName, qualifiedNames] of sourceMap.entries()) {
    mergeTypePreferenceMap(targetMap, typeName, qualifiedNames);
  }
  return targetMap;
}

function dedupeFieldDescriptorsByName(fields) {
  const dedupedFields = [];
  const seenFieldsByName = new Map();
  for (const field of fields || []) {
    const normalizedName = String(field?.name || "").trim();
    if (!normalizedName) {
      continue;
    }
    const existing = seenFieldsByName.get(normalizedName);
    if (!existing) {
      seenFieldsByName.set(normalizedName, field);
      dedupedFields.push(field);
      continue;
    }
    existing.supportsCamelCaseAccess =
      Boolean(existing.supportsCamelCaseAccess) || Boolean(field.supportsCamelCaseAccess);
    if (!existing.annotation && field.annotation) {
      existing.annotation = field.annotation;
    }
  }
  return dedupedFields;
}

function dedupeStructuredFields(fields) {
  const dedupedFields = [];
  const seenFields = new Set();
  for (const field of fields || []) {
    const normalizedName = String(field?.name || "").trim();
    const normalizedAnnotation = String(field?.annotation || "").trim().replace(/\s+/g, " ");
    if (!normalizedName) {
      continue;
    }
    const key = `${normalizedName}:${normalizedAnnotation}`;
    if (seenFields.has(key)) {
      continue;
    }
    seenFields.add(key);
    dedupedFields.push(field);
  }
  return dedupedFields;
}

function parseTypeAnnotationNodes(annotation) {
  const tokens = tokenizeTypeAnnotation(annotation);
  if (tokens.length === 0) {
    return [];
  }

  let pointer = 0;

  const parseSequence = (stopType = "") => {
    const nodes = [];
    while (pointer < tokens.length) {
      const token = tokens[pointer];
      if (stopType && token.type === stopType) {
        break;
      }
      if (token.type === ",") {
        pointer += 1;
        continue;
      }
      const node = parseUnion();
      if (node) {
        nodes.push(node);
      } else {
        pointer += 1;
      }
    }
    return nodes;
  };

  const parseUnion = () => {
    let left = parsePrimary();
    if (!left) {
      return null;
    }

    const unionItems = [left];
    while (pointer < tokens.length && tokens[pointer].type === "|") {
      pointer += 1;
      const right = parsePrimary();
      if (right) {
        unionItems.push(right);
      }
    }

    if (unionItems.length === 1) {
      return unionItems[0];
    }

    return {
      kind: "union",
      items: unionItems
    };
  };

  const parsePrimary = () => {
    const token = tokens[pointer];
    if (!token) {
      return null;
    }

    if (token.type === "name") {
      pointer += 1;
      const node = {
        kind: "name",
        name: token.value,
        args: []
      };
      if (pointer < tokens.length && tokens[pointer].type === "[") {
        pointer += 1;
        node.args = parseSequence("]");
        if (pointer < tokens.length && tokens[pointer].type === "]") {
          pointer += 1;
        }
      }
      return node;
    }

    if (token.type === "(") {
      pointer += 1;
      const innerNodes = parseSequence(")");
      if (pointer < tokens.length && tokens[pointer].type === ")") {
        pointer += 1;
      }
      if (innerNodes.length === 1) {
        return innerNodes[0];
      }
      if (innerNodes.length > 1) {
        return {
          kind: "tuple",
          items: innerNodes
        };
      }
      return null;
    }

    return null;
  };

  return parseSequence();
}

function tokenizeTypeAnnotation(annotation) {
  const source = String(annotation || "");
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (char === "[" || char === "]" || char === "(" || char === ")" || char === "|" || char === ",") {
      tokens.push({ type: char, value: char });
      index += 1;
      continue;
    }

    if (char === "'" || char === '"') {
      const quote = char;
      let endIndex = index + 1;
      while (endIndex < source.length) {
        if (source[endIndex] === quote && source[endIndex - 1] !== "\\") {
          break;
        }
        endIndex += 1;
      }
      const quotedValue = source.slice(index + 1, Math.min(endIndex, source.length));
      const parsedQuotedName = parseQuotedTypeAnnotationName(quotedValue);
      if (parsedQuotedName) {
        tokens.push({ type: "name", value: parsedQuotedName });
      }
      index = Math.min(endIndex + 1, source.length);
      continue;
    }

    if (/[A-Za-z_]/.test(char)) {
      const start = index;
      index += 1;
      while (index < source.length && /[A-Za-z0-9_.]/.test(source[index])) {
        index += 1;
      }
      tokens.push({ type: "name", value: source.slice(start, index) });
      continue;
    }

    index += 1;
  }

  return tokens;
}

function parseQuotedTypeAnnotationName(value) {
  const source = String(value || "").trim();
  if (!source) {
    return "";
  }
  const match = source.match(/[A-Za-z_][A-Za-z0-9_.]*/);
  return match ? match[0] : "";
}

function hasIndexedTypeForQualifiedName(index, qualifiedName) {
  const normalizedQualifiedName = normalizeQualifiedTypeName(qualifiedName);
  if (!normalizedQualifiedName) {
    return false;
  }

  for (const [key] of index?.structuredTypesByQualifiedName || []) {
    if (normalizeQualifiedTypeName(key) === normalizedQualifiedName) {
      return true;
    }
  }
  for (const [key] of index?.enumsByQualifiedName || []) {
    if (normalizeQualifiedTypeName(key) === normalizedQualifiedName) {
      return true;
    }
  }
  return false;
}

function hasIndexedTypeForName(index, typeName) {
  const simpleName = extractTypeSimpleName(typeName);
  if (!simpleName) {
    return false;
  }
  return Boolean(index.structuredTypesByName?.has(simpleName) || index.enumsByName?.has(simpleName));
}

function formatEnumMemberForDisplay(member) {
  const memberName = String(member.name || "");
  const valueLiteral = member.valueLiteral;
  if (valueLiteral === undefined || valueLiteral === null || valueLiteral.length === 0) {
    return memberName;
  }
  if (valueLiteral === memberName) {
    return memberName;
  }
  return `${memberName} = ${valueLiteral}`;
}

function extractTypeSimpleName(typeName) {
  const source = String(typeName || "").trim();
  if (!source) {
    return "";
  }
  const segments = source.split(".");
  return String(segments[segments.length - 1] || "").trim();
}

function normalizeQualifiedTypeName(value) {
  const source = String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\//g, ".")
    .replace(/\.{2,}/g, ".");
  if (!source) {
    return "";
  }
  return source
    .split(".")
    .map((segment) => String(segment || "").trim())
    .filter(Boolean)
    .join(".")
    .toLowerCase();
}

function normalizeComparableToken(value) {
  return String(value || "").trim().toLowerCase();
}

function uniqueStrings(values) {
  const result = [];
  const seen = new Set();
  for (const value of values || []) {
    const normalized = String(value || "").trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

module.exports = {
  __test__: {
    normalizeReturnFieldNameStyle,
    buildSimpleReturnAccessTemplate,
    bindSimpleReturnAccessTemplate,
    collectReturnMemberCompletionCandidatesFromTemplate,
    buildReturnStructureLines
  }
};
