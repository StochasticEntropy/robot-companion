# Keyword source declarations behind custom decorators

A native class library can have readable own keyword declarations while its full
runtime contract remains unknown (for example, an imported base class or a
custom method decorator). The source-declaration reader follows an explicitly
selected class, its own literal keyword names and explicit Python import
bindings. It never searches the workspace for a same-named function.

The bounded decorator proof recognizes RF's standard keyword decorator, a
forwarding factory preserving its positional/keyword arguments, and a returned
decorator whose returned wrapper applies the standard keyword decorator to the
incoming name and uses `functools.wraps` on the original callable. This is source
inspection only. The reader refuses computed/transformed names, rebinding,
mutated or escaped forwarding arguments, cycles, excessive depth and duplicate own names.
Forwarding factories use a direct passthrough return (with an optional docstring),
without consumed positional arguments. Relevant lexical scopes cannot shadow the
metadata imports, captured name or original callable, rebind the returned
functions, or use dynamic rebinding APIs. The returned decorator has one ordinary
callable parameter; more complex factory shapes remain unsupported.
It does not execute helper modules or arbitrary library code.

Such targets retain the original declaration's URI, line, docstring, annotations
and declared parameters. Their locations and keyword-list entries carry
`sourceKind: "declaration"`; keyword-list entries also carry
`runtimeSignatureKnown: false`. The client validates these markers and keeps the
source kind when deduplicating locations. Return Explorer and hover label the
result as a source declaration and explain that runtime decorators can add or
alter parameters. Existing exact URI/line metadata joins remain in effect.

Source declarations do not turn a partial class reading into a verified runtime
keyword catalog. They do not authorize rename edits, missing-import edits or argument-count diagnostics
based on an unknown wrapper signature. Debugging and execution admission remain
unchanged.

Parsed module-name information belongs to the bounded exact-content source
cache. Factory proofs are bounded to 128 entries within the current request and
are discarded when that request ends or an open document changes/closes. They
are not reused across requests: helper changes, import changes and newly created
modules are checked again. No persistent project-specific decorator aliases or
private project code are shipped.

Repeated explicit decorator-module lookups share the same bounded request memo.
Module locations, including missing modules, are never retained across requests;
new files, deletion and changed search paths are therefore checked again.
