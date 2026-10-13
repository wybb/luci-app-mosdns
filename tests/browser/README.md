# Real LuCI browser fixture

This is **not** the Node form-schema stub. It serves unmodified `luci.js`
(including DOM/baseclass/view), `cbi.js`, `form.js`, `ui.js`, `uci.js`, validation,
RPC client and Bootstrap CSS from:

- `https://github.com/coolsnowwolf/luci.git`
- branch `openwrt-25.12`
- pinned commit `cae27bd8ad448b7d6216c581cd2852ffa971b1c5`

Only the HTTP/ubus router backend is simulated. No router, user browser profile,
credentials, external DNS server, or real service reload is used.

## Run

Use Python 3 with official `playwright` installed and an installed Chromium.

```sh
git clone --depth 1 --branch openwrt-25.12 https://github.com/coolsnowwolf/luci.git /tmp/luci-browser-source
# If the branch has advanced, fetch and check out the pinned commit above.
python tests/browser/test_luci_browser.py --luci-source /tmp/luci-browser-source --chromium /usr/bin/chromium
```

The script refuses a different LuCI commit, emits per-case results and writes
`results.json`, screenshots and failure HTML under `/tmp/mosdns-browser-results`.
It exits nonzero on failure. Headless browser launch failure is a blocker, never
a pass. No automatic security/sandbox workaround is attempted.

For manual browser testing (Python standard library only):

```sh
python tests/browser/test_luci_browser.py --luci-source /tmp/luci-browser-source --serve-only --port 8766
```

Open `http://127.0.0.1:8766/?view=rules_v2`. Other views are `basic_v2`,
`dns_groups_v2`, and `ip_mapping_v2`. Add `&reset=1` for deterministic reset or
`&reset=1&missing=1` for a disabled rule with an unreadable source file. Do not
reload a reset URL when testing persistence: remove the reset query first.
`/narrow` creates a 390px iframe viewport with upstream mobile.css applied.
This tests responsive layout, **not** phone hardware or touch gestures.

The automated suite covers render, add/dismiss, named-group rename/deletion
protection, new anonymous rule IDs, file write ordering/failure, missing-file
recovery, standard Save & Apply confirmation, reordering, and narrow modal
layout. Its synthetic HTML5 drag events exercise real upstream handlers, not
an actual mouse/touch gesture. See the execution record below before claiming
any automated result.

## Execution record: 2026-10-13

Headless execution was blocked in the initial executor: Chromium process socket
returned EPERM; an approved elevated launch failed inside executor bubblewrap
before Chromium ran. Therefore the complete **automated suite has not passed**.
Python syntax compilation passed.

A supported cloud Chromium tab subsequently loaded the same fixture with the
real pinned LuCI libraries. The following flows were actually performed through
browser UI controls:

- All four v2 pages rendered, including real lists, validation and modals.
- Rule Add → Dismiss → Save left two original rows, without a phantom new row.
- Rule Add → name/content → modal Save created `cfg000008`; reopening restored
  content. Renaming retained `cfg000008`.
- Standard Save & Apply displayed `Configuration changes applied.` with the
  simulated apply/confirm backend.
- A disabled rule with a missing source file did not block the page or Save.
  Its editor showed the retained path and read error. Saving replacement text
  and reopening restored the replacement and removed the error.
- Default DNS-group deletion was blocked with the expected warning.
- DNS-group display-name edits retained the named section ID.
- Adding `dns_browser` immediately added its ID to the default selector;
  deleting that unused group removed both the row and selector entry.
- IP mapping Add → Dismiss left original rows; deleting the second mapping
  removed only that row.
- At a 390px iframe width with Bootstrap mobile CSS, the final `.cbi-tblsection`
  container measured clientWidth 350, scrollWidth 768, overflow-x auto; the
  document scrollWidth was 375. Horizontal scrolling exposed the complete
  Edit/Delete controls without shifting the rest of the page.

### Bugs found and retested after fixes

1. DNS choices accumulated duplicate entries on every load/modal open.
2. Default-group labels remained stale after display-name edits; selector now
   deliberately uses stable IDs, with display names in the table.
3. Deleted groups remained as ghost selector choices.
4. Narrow tables clipped actions; the first CSS fix targeted the wrong actual
   LuCI container. The corrected `.cbi-tblsection` scroll wrapper was verified.
5. Rule modes and mapping Continue/Stop initially displayed raw enum values;
   readable rule-mode labels were verified after the textvalue fix.

### Remaining limits

- The browser automation's attempted physical drag produced no reorder. This
  is **inconclusive**, not a demonstrated app failure or a passed sort test.
  The reusable automated reorder case still needs execution in a working
  isolated Chromium environment, plus a real-device touch check.
- Long-name rendering was exercised and exposed the original narrow-column
  problem; final scrolling was retested with normal names. Extremely long
  unbroken names and all theme variants remain unverified.
- Full automated failure-injection assertions are prepared but not executed.
- RPC/atomic filesystem implementation, real uhttpd/rpcd ACLs, actual service
  restarts, phone touch input and the user's unknown installed theme are outside
  this fixture. Browser UI success is not an on-router deployment test.

a local narrow-screen verification screenshot (not included in the source tree) is the final actual browser screenshot:
390px fixture on the left, empty host-page background on the right. It shows
complete action buttons after scrolling the table, while the settings/footer
remain stationary.
