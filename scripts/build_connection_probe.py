"""Build a separate connection probe VPK without replacing the player package.

The probe stops normal bridge jobs, uses the existing XML HTML panel, and reports
only navigation/interface facts through local Image requests and $.Msg. It does
not send chat text or change player settings. Run connection_probe_server.py
before starting the game with this package enabled instead of the normal mod.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from scripts.extract_vpk import read_entry, read_index
from scripts.stage_compile import CSDK_COMPILER, CSDK_ROOT, write_vpk


PROBE_JS = r'''
	function connectionProbeBoot() {
		var root = $.GetContextPanel();
		var input = root.FindChildTraverse("ChatInput");
		if (!isValid(input)) return; // One probe session, in the chat layout only.
		var panel = root.FindChildTraverse("DLChatBridge");
		// Wait for the player to open chat before starting navigation or image beacons.
		if (panel) {
			try {
				panel.style.width = "16px"; panel.style.height = "16px";
				panel.style.marginLeft = "0px"; panel.style.marginTop = "0px";
				panel.style.opacity = "0.01"; panel.style.zIndex = "1";
			} catch (e) {}
			if (!panelOnScreen(panel)) {
				status.show("打开聊天框后开始通译连接诊断", 120);
				$.Schedule(0.5, connectionProbeBoot);
				return;
			}
		}
		exportGlobals();
		bus.send = function (op, payload, timeout, cb) {
			if (cb) cb({ ok: false, error: "连接诊断包：翻译暂未启用" });
		};
		var session = "TYHTTPS" + String(Date.now());
		var reports = [], beacons = [], count = 0, step = "boot";
		var eventCounts = {}, eventReports = {}, markerSeen = {}, imageLoaded = false;
		function clip(value, limit) { return String(value || "").substring(0, limit || 220); }
		function attr(p, name) {
			try { return clip(p.GetAttributeString(name, "")); } catch (e) { return ""; }
		}
		function facts() {
			var out = { panel: !!panel, visible: panelOnScreen(panel),
				title: "", url: "", src: attr(panel, "src") };
			try { out.title = clip(panel.title); } catch (e) {}
			try { out.url = clip(panel.url); } catch (e) {}
			return out;
		}
		function report(kind, data) {
			if (count >= 120 && kind !== "result" && kind !== "snapshot") return;
			var record = { session: session, n: ++count, kind: kind, step: step, data: data };
			reports.push(record);
			try { $.Msg("[tongyi-connection-probe] " + JSON.stringify(record) + "\n"); } catch (e) {}
			try {
				var image = $.CreatePanel("Image", root, "DLChatProbeBeacon" + count);
				image.style.width = "1px"; image.style.height = "1px";
				image.style.opacity = "0.01";
				beacons.push(image); // Keep each panel alive; do not overwrite pending images.
				image.SetImage("http://localhost:8793/event.png?d=" + enc(JSON.stringify(record)));
			} catch (e) {}
		}
		if (!panel) { report("missing-panel", facts()); return; }
		function accept(name, args) {
			var values = [];
			for (var i = 0; i < args.length && i < 8; i++) {
				var arg = args[i], text = eventText(arg);
				if (text) values.push(clip(text, 240));
				else if (typeof arg === "number" || typeof arg === "boolean") values.push(String(arg));
				else { try { if (arg && arg.id) values.push("panel:" + arg.id); } catch (e) {} }
			}
			var joined = values.join(" ");
			// Navigation URLs also contain the session; only the page title proves a response.
			if (name === "HTMLTitle" && joined.indexOf("LCTPROBE") !== -1 &&
				joined.indexOf(session) !== -1) markerSeen[step] = true;
			eventCounts[name] = (eventCounts[name] || 0) + 1;
			var key = step + ":" + name;
			eventReports[key] = (eventReports[key] || 0) + 1;
			if (eventReports[key] <= 3) {
				report("html-event", { name: name, args: values, facts: facts() });
			}
		}
		var names = ["HTMLLoadPage", "HTMLStartRequest", "HTMLFinishRequest", "HTMLURLChanged", "HTMLTitle"];
		for (var i = 0; i < names.length; i++) {
			(function (name) {
				try {
					if (typeof $.RegisterEventHandler === "function") {
						$.RegisterEventHandler(name, panel, function () { accept(name, arguments); });
						report("register", { name: name, mode: "panel" });
					} else {
						$.RegisterForUnhandledEvent(name, function () {
							var ours = false;
							for (var a = 0; a < arguments.length; a++) {
								if (arguments[a] === panel) ours = true;
								try { if (arguments[a] && arguments[a].id === panel.id) ours = true; } catch (e) {}
								if (eventText(arguments[a]).indexOf(session) !== -1) ours = true;
							}
							if (ours) accept(name, arguments);
						});
						report("register", { name: name, mode: "filtered-global" });
					}
				} catch (e) { report("register-error", { name: name, error: clip(e) }); }
			})(names[i]);
		}
		try {
			var baseline = $.CreatePanel("Image", root, "DLChatProbeImage");
			baseline.style.width = "1px"; baseline.style.height = "1px";
			baseline.style.opacity = "0.01"; beacons.push(baseline);
			if (typeof $.RegisterEventHandler === "function") {
				$.RegisterEventHandler("ImageLoaded", baseline, function () {
					imageLoaded = true; report("image-loaded", { ok: true });
				});
			}
			baseline.SetImage("http://localhost:8793/image.png?session=" + session);
		} catch (e) { report("image-error", { error: clip(e) }); }
		report("boot", facts());
		var cases = [
			{ name: "blank", url: "about:blank", wait: 2 },
			{ name: "http", url: "http://localhost:8793/ping?m=" + session + "HTTP", wait: 8 },
			{ name: "https-localhost", url: "https://localhost:8792/ping?m=" + session + "HTTPS", wait: 12 },
			{ name: "https-ip", url: "https://127.0.0.1:8792/ping?m=" + session + "HTTPSIP", wait: 12 }
		];
		function run(index) {
			if (index >= cases.length) {
				step = "done";
				report("result", { markers: markerSeen, imageLoaded: imageLoaded, events: eventCounts, facts: facts() });
				status.show("通译连接诊断完成，请返回聊天查看结果", 120);
				return;
			}
			var one = cases[index]; step = one.name;
			status.show("通译连接诊断 " + (index + 1) + "/" + cases.length + "：" + one.name, one.wait + 2);
			report("navigate", { url: one.url, facts: facts() });
			try { panel.SetURL(one.url); }
			catch (e) { report("navigation-error", { error: clip(e) }); }
			$.Schedule(one.wait, function () {
				report("snapshot", { markerSeen: !!markerSeen[one.name], facts: facts() });
				run(index + 1);
			});
		}
		$.Schedule(2, function () { run(0); });
	}
'''


IMAGE_PROBE_JS = r'''
	function connectionProbeBoot() {
		var root = $.GetContextPanel(), input = root.FindChildTraverse("ChatInput");
		if (!isValid(input)) return;
		if (!panelOnScreen(input)) {
			status.show("打开聊天框后开始通译图片诊断", 120);
			$.Schedule(0.5, connectionProbeBoot);
			return;
		}
		exportGlobals();
		bus.send = function (op, payload, timeout, cb) {
			if (cb) cb({ ok: false, error: "图片诊断包：翻译暂未启用" });
		};
		var session = "TYIMAGE" + String(Date.now()), count = 0, kept = [], results = {};
		function record(kind, data) {
			var out = { session: session, n: ++count, kind: kind, step: "image", data: data };
			try { $.Msg("[tongyi-image-probe] " + JSON.stringify(out) + "\n"); } catch (e) {}
			try {
				var beacon = $.CreatePanel("Image", root, "DLChatImageBeacon" + count);
				beacon.style.width = "1px"; beacon.style.height = "1px";
				beacon.style.opacity = "0.01"; kept.push(beacon);
				beacon.SetImage("http://localhost:8793/event.png?d=" + enc(JSON.stringify(out)));
			} catch (e) {}
		}
		function dimensions(image) {
			var names = ["contentwidth", "contentheight", "desiredlayoutwidth", "desiredlayoutheight",
				"actuallayoutwidth", "actuallayoutheight", "actualuiscale_x", "actualuiscale_y",
				"texturewidth", "textureheight"], out = {};
			for (var i = 0; i < names.length; i++) {
				try { var v = image[names[i]]; out[names[i]] = v === undefined ? "undefined" : v; }
				catch (e) { out[names[i]] = "error:" + String(e).substring(0, 80); }
			}
			return out;
		}
		function observe(image, name) {
			var events = ["ImageLoaded", "ImageFailedLoad"];
			for (var j = 0; j < events.length; j++) {
				(function (eventName) {
					try {
						$.RegisterEventHandler(eventName, image, function () {
							var args = [];
							for (var a = 0; a < arguments.length && a < 5; a++) {
								var arg = arguments[a];
								try { args.push(arg && arg.id ? "panel:" + arg.id : String(arg).substring(0, 80)); }
								catch (e) { args.push("unreadable"); }
							}
							results[name] = { event: eventName, dims: dimensions(image) };
							record("image-event", { name: name, event: eventName, args: args, dims: dimensions(image) });
							$.Schedule(0.2, function () {
								results[name].dims = dimensions(image);
								record("image-dimensions", { name: name, dims: dimensions(image) });
							});
						});
					} catch (e) { record("register-error", { name: name, event: eventName, error: String(e) }); }
				})(events[j]);
			}
		}
		var box = $.CreatePanel("Panel", root, "DLChatImageProbeBox");
		box.style.width = "300px"; box.style.height = "300px";
		box.style.opacity = "0.01"; box.style.position = "0px 0px 0px";
		try { box.hittest = false; box.hittestchildren = false; } catch (e) {}
		kept.push(box);
		var cases = [
			{ name: "fit-17x29", path: "/size.png?w=17&h=29", fit: true },
			{ name: "fit-256x255", path: "/size.png?w=256&h=255", fit: true },
			{ name: "fit-1x256", path: "/size.png?w=1&h=256", fit: true },
			{ name: "fit-256x1", path: "/size.png?w=256&h=1", fit: true },
			{ name: "reload", path: "/size.png?w=9&h=7", fit: true, reload: true },
			{ name: "auto-53x11", path: "/size.png?w=53&h=11", fit: false },
			{ name: "fixed-37x19", path: "/size.png?w=37&h=19", fixed: true },
			{ name: "missing", path: "/missing.png", fixed: true },
			{ name: "broken", path: "/broken.png", fixed: true }
		];
		record("image-boot", { visible: panelOnScreen(input), cases: cases.length });
		status.show("通译图片诊断中，请保持聊天框打开", 30);
		for (var i = 0; i < cases.length; i++) {
			(function (one, index) {
				var image = $.CreatePanel("Image", box, "DLChatImageCase" + index); kept.push(image);
				if (one.fit) { image.style.width = "fit-children"; image.style.height = "fit-children"; }
				if (one.fixed) { image.style.width = "1px"; image.style.height = "1px"; }
				observe(image, one.name);
				record("image-request", { name: one.name, path: one.path });
				var separator = one.path.indexOf("?") === -1 ? "?" : "&";
				image.SetImage("http://localhost:8793" + one.path + separator + "session=" + session + "&case=" + one.name);
				if (one.reload) {
					$.Schedule(1, function () {
						record("image-reload", { name: one.name, width: 63, height: 127 });
						image.SetImage("http://localhost:8793/size.png?w=63&h=127&session=" + session + "&case=reload");
					});
					$.Schedule(3, function () {
						record("image-reload", { name: one.name, width: 215, height: 3 });
						image.SetImage("http://localhost:8793/size.png?w=215&h=3&session=" + session + "&case=reload");
					});
				}
			})(cases[i], i);
		}
		$.Schedule(8, function () {
			for (var i = 0; i < cases.length; i++) record("image-result", { name: cases[i].name, result: results[cases[i].name] || null });
			status.show("通译图片诊断完成，请返回聊天查看结果", 120);
		});
	}
'''


def build(base: Path, output: Path, *, image_only: bool = False) -> Path:
    source = (ROOT / "mod/panorama/scripts/dlchat.js").read_text(encoding="utf-8")
    tail = '\ttry { $.Schedule(0.3, boot); } catch (e) {}\n})();'
    if source.count(tail) != 1:
        raise ValueError("Cannot identify the mod boot entry point")
    source = source.replace(tail, (IMAGE_PROBE_JS if image_only else PROBE_JS)
                            + tail.replace("0.3, boot", "0.3, connectionProbeBoot"))
    addon = "tongyi_image_probe" if image_only else "tongyi_connection_probe"
    src = CSDK_ROOT / "content/citadel_addons" / addon / "panorama/scripts/dlchat.js"
    compiled = CSDK_ROOT / "game/citadel_addons" / addon / "panorama/scripts/dlchat.vjs_c"
    src.parent.mkdir(parents=True, exist_ok=True)
    compiled.parent.mkdir(parents=True, exist_ok=True)
    src.write_text(source, encoding="utf-8")
    subprocess.run(["node", "--check", str(src)], check=True)
    result = subprocess.run(
        [str(CSDK_COMPILER), "-nop4", "-i", str(src), "-o", str(compiled)],
        capture_output=True, text=True, errors="replace", cwd=CSDK_ROOT,
    )
    if result.returncode != 0 or not compiled.exists():
        raise RuntimeError(result.stdout + result.stderr)
    files = {name: read_entry(base, archive, offset, length)
             for name, archive, offset, length in read_index(base)}
    files["panorama/scripts/dlchat.vjs_c"] = compiled.read_bytes()
    return write_vpk(files, output)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", type=Path, default=ROOT / "build/tongyi-pak01_dir.vpk")
    parser.add_argument("--output", type=Path,
                        default=ROOT / "build/tongyi-connection-probe-pak01_dir.vpk")
    parser.add_argument("--image-only", action="store_true", help="Probe image dimensions and failure events")
    args = parser.parse_args()
    if args.output.resolve() == args.base.resolve():
        parser.error("The diagnostic VPK must not replace the player VPK")
    print(build(args.base, args.output, image_only=args.image_only))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
