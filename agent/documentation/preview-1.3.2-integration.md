# Preview 1.3.2 integration

Owner instruction, 21 October 2026: integrate finished work, publish a preview, then repair stalled Robot Companion and Mission Control execution.

The candidate starts from published f89ddff. It includes accepted MIS-616 (port of MIS-434 on MIS-482/MIS-604), MIS-505, MIS-485, MIS-600, MIS-631 (including MIS-491), MIS-585 and MIS-270. MIS-441 semantic helpers and its UI suite were verified already present in the published baseline; its ancestry is recorded without replacing newer library/explorer behavior. MIS-447 and MIS-444 were consumed by their scoped accepted changes.

Integration resolutions preserve the 1.3.1 byte-preserving stream and OS-listener checks, Windows cleanup and cancelable writer, while incorporating the accepted interpreter-identity spelling and cancelable reader. Source actions and Python rename share the client's versioned-edit capability. The central UI suite registry includes keyword browsing and environment checks. The standalone backend release harness includes the new library and explorer live suites; these are required and cannot silently skip.

No rejected MIS-476 implementation is imported as accepted work. Its existing review history and source remain intact for a separate bounded repair. Backend installation is explicitly still manual; MIS-477 and the final combined gate remain open.

Verification receipts are retained outside this checkout in the chat workspace under work/release-1.3.2 and published with the preview. A passing isolated candidate test is not a Windows UI acceptance or a native product-stage approval.
