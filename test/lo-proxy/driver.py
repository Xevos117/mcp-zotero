#!/usr/bin/env python3
# UNO driver of the lo-proxy job: drives a running (non-headless) soffice that has the Zotero LibreOffice
# integration .oxt installed, on one .odt the product injected. Loads the document, runs a Zotero integration
# command through the extension's UNO service, waits for Zotero to finish, then saves the refreshed .odt (writer8)
# and a PDF export. The PDF is turned into PNG pages by run.sh (pdftoppm), for the visual review of word-render.
#
# The command is triggered on the extension's XJobExecutor service, exactly as LibreOffice's Add-on menu does
# (org.zotero.integration.ooo.ZoteroOpenOfficeIntegration, trigger("refresh"|"setDocPrefs"|...)); the agent Zotero
# sees is "LibreOffice". Zotero drives the document over its socket (127.0.0.1:23116) and logs, when done,
#   Integration: LibreOffice-<command>[:'<docId>'] complete in <N>s
# in -ZoteroDebugText output (the zotero.log run.sh tails). trigger() runs in a worker thread and the main thread
# waits for that line with a timeout, so a command that never returns fails the run instead of hanging.
#
# Must run under LibreOffice's own python (program/python): it is the interpreter whose PYTHONPATH exposes `uno`.
# Usage: python driver.py --pipe NAME --in in.odt --out out.odt --pdf out.pdf --command refresh \
#                         --zotero-log zotero.log --timeout 120
import argparse
import os
import sys
import threading
import time

import uno  # noqa: E402  (provided by LibreOffice's bundled python)
from com.sun.star.beans import PropertyValue


def file_url(path):
    return uno.systemPathToFileUrl(os.path.abspath(path))


def prop(name, value):
    p = PropertyValue()
    p.Name = name
    p.Value = value
    return p


def connect(pipe, attempts=160):
    """Resolve the UNO context of the soffice listening on the given pipe (a cold first start can take a while)."""
    local = uno.getComponentContext()
    resolver = local.ServiceManager.createInstanceWithContext(
        "com.sun.star.bridge.UnoUrlResolver", local
    )
    url = "uno:pipe,name=%s;urp;StarOffice.ComponentContext" % pipe
    last = None
    for _ in range(attempts):
        try:
            return resolver.resolve(url)
        except Exception as e:  # NoConnectException while soffice starts its pipe
            last = e
            time.sleep(0.5)
    raise RuntimeError("cannot connect to soffice on pipe %s: %s" % (pipe, last))


def wait_for_complete(log_path, command, deadline, start_offset):
    """Wait until the Zotero debug log shows THIS command completed, or the deadline passes. Only bytes written after
    start_offset are considered, so a completion line from a previous step (same shared log) is never mistaken for
    this one — without it every step after the first would match the first step's line and save an unrefreshed doc."""
    needle = "Integration: LibreOffice-%s" % command
    done = " complete in "
    while time.time() < deadline:
        try:
            with open(log_path, "r", errors="replace") as fh:
                fh.seek(start_offset)
                for line in fh:
                    if needle in line and done in line:
                        return True
        except FileNotFoundError:
            pass
        time.sleep(0.5)
    return False


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--pipe", required=True)
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--pdf", required=True)
    ap.add_argument("--command", default="refresh")
    ap.add_argument("--zotero-log", required=True)
    ap.add_argument("--timeout", type=float, default=120.0)
    args = ap.parse_args(argv)

    ctx = connect(args.pipe)
    smgr = ctx.ServiceManager
    desktop = smgr.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)

    # The Zotero plugin needs a real document frame: load it non-hidden (soffice runs under Xvfb, never headless).
    doc = desktop.loadComponentFromURL(file_url(args.inp), "_blank", 0, (prop("Hidden", False),))
    if doc is None:
        raise RuntimeError("could not load %s" % args.inp)

    zotero = smgr.createInstanceWithContext(
        "org.zotero.integration.ooo.ZoteroOpenOfficeIntegration", ctx
    )
    if zotero is None:
        raise RuntimeError("Zotero LibreOffice integration service not available (is the .oxt installed?)")

    error = {}

    def run_command():
        try:
            zotero.trigger(args.command)
        except Exception as e:  # surfaced after the wait, never swallowed
            error["trigger"] = str(e)

    worker = threading.Thread(target=run_command, daemon=True)
    # Only completion lines written from here on count as this step's (the log is shared across steps)
    try:
        start_offset = os.path.getsize(args.zotero_log)
    except OSError:
        start_offset = 0
    worker.start()

    ok = wait_for_complete(args.zotero_log, args.command, time.time() + args.timeout, start_offset)
    worker.join(timeout=10)

    if not ok:
        sys.stderr.write(
            "driver: Zotero did not log '%s ... complete' within %.0fs%s\n"
            % (args.command, args.timeout, (" (trigger error: %s)" % error["trigger"]) if "trigger" in error else "")
        )
        try:
            doc.close(False)
        except Exception:
            pass
        return 3

    # Store the refreshed document and a PDF export (PDF -> PNG is run.sh's job, with pdftoppm)
    doc.storeToURL(file_url(args.out), (prop("FilterName", "writer8"),))
    doc.storeToURL(file_url(args.pdf), (prop("FilterName", "writer_pdf_Export"),))
    doc.close(False)
    print("driver: %s complete, saved %s and %s" % (args.command, os.path.basename(args.out), os.path.basename(args.pdf)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
