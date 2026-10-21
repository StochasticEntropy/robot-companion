const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const { WebviewCdp } = require("./webview-cdp");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
class EnvironmentCdp {
  static async connect() {
    const cdp = await WebviewCdp.connect();
    // These journeys resize the native X11 window at two desktop sizes.
    // Remove the fixed language-suite viewport before observing native geometry.
    await cdp.send("Emulation.clearDeviceMetricsOverride", {}, cdp.pageSession);
    return new EnvironmentCdp(cdp);
  }
  constructor(cdp) { this.cdp = cdp; this.actions = []; }
  async eval(expression) {
    const r = await this.cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, this.cdp.pageSession);
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
  async wait(expression, timeout = 12000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const r = await this.eval(expression); if (r) return r; await sleep(75); }
    throw new Error(`Timed out: ${expression}; UI: ${await this.eval("document.body.innerText.slice(-5000)")}`);
  }
  async key(key, modifiers = 0) {
    const codes = { Enter: 13, Escape: 27, F1: 112, F5: 116, F9: 120, F12: 123, ArrowDown: 40, ArrowUp: 38, Tab: 9, End: 35, Backspace: 8, " ": 32, a: 65 };
    const code = { a: "KeyA", " ": "Space" }[key] || key;
    for (const type of ["keyDown", "keyUp"]) await this.cdp.send("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode: codes[key], modifiers }, this.cdp.pageSession);
    this.actions.push({ key, modifiers }); await sleep(100);
  }
  async text(text) { await this.cdp.send("Input.insertText", { text }, this.cdp.pageSession); this.actions.push({ type: text }); await sleep(120); }
  // Toasts slide in and the status bar reflows after a resize: click only a visible, settled target.
  async point(expression) {
    return this.wait(`(async () => {
      const box = () => { const el = ${expression}; const r = el?.getBoundingClientRect(); return r && r.width && r.height && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight ? r : undefined; };
      const a = box(); await new Promise(resolve => setTimeout(resolve, 150)); const b = box();
      return a && b && a.x === b.x && a.y === b.y ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : false;
    })()`);
  }
  async press(point) {
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await this.cdp.send("Input.dispatchMouseEvent", { type, ...point, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 }, this.cdp.pageSession);
  }
  async click(expression) {
    const point = await this.point(expression);
    await this.press(point);
    this.actions.push({ click: expression, point }); await sleep(200);
  }
  // Two real pointer clicks on one target, the second gapMs after the first.
  async doubleClick(expression, gapMs) {
    const point = await this.point(expression);
    await this.press(point); await sleep(gapMs); await this.press(point);
    this.actions.push({ click: expression, point, again: gapMs }); await sleep(200);
  }
  // A resting pointer over a point, as for an editor hover.
  async hover(point) {
    for (const offset of [0, 1]) {
      await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x + offset, y: point.y }, this.cdp.pageSession);
      await sleep(150);
    }
    this.actions.push({ hover: point });
  }
  // The status tooltip stays open under a resting pointer and covers the notification corner.
  async away() {
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 600, y: 300 }, this.cdp.pageSession);
    await this.wait("![...document.querySelectorAll('.workbench-hover, .monaco-hover')].some(el => el.getClientRects().length && el.textContent.includes('Select Robot Environment'))");
    this.actions.push({ pointerAway: { x: 600, y: 300 } });
  }
  async palette(command) {
    await this.key("F1");
    await this.wait("document.activeElement?.matches('.quick-input-widget input')");
    await this.text(command);
    await this.wait(`document.querySelector('.quick-input-widget .monaco-list-row')?.textContent.includes(${JSON.stringify(command.split(": ").pop())})`);
    await this.key("Enter");
  }
  async filter(text) { await this.key("a", 2); await this.text(text); }
  async resize(width, height) {
    // Electron does not support Browser.getWindowForTarget; resize its owned X11 window.
    const tree = cp.execFileSync("xwininfo", ["-root", "-tree"], { encoding: "utf8" });
    const row = tree.split("\n").find(line => /0x[0-9a-f]+.*Extension Development Host/.test(line));
    if (!row) throw new Error(`No owned development window: ${tree}`);
    const id = row.match(/0x[0-9a-f]+/)[0];
    cp.execFileSync("python3", ["-c", "import ctypes,sys\nx=ctypes.CDLL('libX11.so.6');x.XOpenDisplay.restype=ctypes.c_void_p;d=x.XOpenDisplay(None);x.XResizeWindow.argtypes=[ctypes.c_void_p,ctypes.c_ulong,ctypes.c_uint,ctypes.c_uint];x.XResizeWindow(d,int(sys.argv[1],16),int(sys.argv[2]),int(sys.argv[3]));x.XFlush.argtypes=[ctypes.c_void_p];x.XFlush(d)", id, String(width), String(height)]);
    await this.wait(`innerWidth === ${width} && innerHeight === ${height}`);
    this.actions.push({ nativeSize: [width, height] });
  }
  async retain(name) {
    const dir = process.env.ROBOT_COMPANION_EVIDENCE_DIR;
    if (!dir) return;
    fs.mkdirSync(dir, { recursive: true });
    const { data } = await this.cdp.send("Page.captureScreenshot", { format: "png" }, this.cdp.pageSession);
    fs.writeFileSync(path.join(dir, `${name}.png`), Buffer.from(data, "base64"));
    fs.writeFileSync(path.join(dir, "interactive-actions.json"), JSON.stringify(this.actions, null, 2));
  }
  close() { this.cdp.close(); }
}
module.exports = { EnvironmentCdp, sleep };
