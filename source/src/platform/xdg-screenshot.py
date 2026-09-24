#!/usr/bin/python3
"""Capture a non-interactive screenshot through xdg-desktop-portal."""

import json
import os
from pathlib import Path
import secrets
import shutil
import stat
import sys
import time
from urllib.parse import unquote, urlsplit

if __name__ == "__main__":
    try:
        stderr_sink = os.open(os.devnull, os.O_WRONLY)
        os.dup2(stderr_sink, 2)
        os.close(stderr_sink)
    except OSError:
        pass

try:
    from gi.repository import Gio, GLib
except (ImportError, ValueError):
    Gio = None
    GLib = None


PORTAL_BUS_NAME = "org.freedesktop.portal.Desktop"
PORTAL_OBJECT_PATH = "/org/freedesktop/portal/desktop"
SCREENSHOT_INTERFACE = "org.freedesktop.portal.Screenshot"
REQUEST_INTERFACE = "org.freedesktop.portal.Request"
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
DEFAULT_TIMEOUT_MS = 10_000
MIN_TIMEOUT_MS = 10
MAX_TIMEOUT_MS = 60_000


class PortalFailure(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def emit_status(ok, code, message, exit_code):
    payload = {
        "ok": bool(ok),
        "backend": "xdg-screenshot-portal",
        "code": code,
        "message": message,
    }
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()
    return exit_code


def parse_timeout(raw_value):
    if raw_value is None:
        return DEFAULT_TIMEOUT_MS
    try:
        timeout_ms = int(raw_value, 10)
    except (TypeError, ValueError):
        raise PortalFailure("invalid-arguments")
    if timeout_ms < MIN_TIMEOUT_MS or timeout_ms > MAX_TIMEOUT_MS:
        raise PortalFailure("invalid-arguments")
    return timeout_ms


def validate_destination(raw_value):
    if not isinstance(raw_value, str) or not raw_value or "\x00" in raw_value:
        raise PortalFailure("invalid-destination")

    destination = Path(raw_value)
    if not destination.is_absolute() or destination.suffix.lower() != ".png":
        raise PortalFailure("invalid-destination")

    try:
        parent = destination.parent.resolve(strict=True)
    except (OSError, RuntimeError):
        raise PortalFailure("invalid-destination")

    if not parent.is_dir() or not os.access(parent, os.W_OK | os.X_OK):
        raise PortalFailure("invalid-destination")

    normalized = parent / destination.name
    try:
        if normalized.is_symlink() or (normalized.exists() and not normalized.is_file()):
            raise PortalFailure("invalid-destination")
    except OSError:
        raise PortalFailure("invalid-destination")

    return normalized


def response_uri_to_path(uri):
    if not isinstance(uri, str):
        raise PortalFailure("invalid-response")

    parsed = urlsplit(uri)
    if (
        parsed.scheme != "file"
        or parsed.netloc not in ("", "localhost")
        or parsed.query
        or parsed.fragment
    ):
        raise PortalFailure("invalid-response")

    source = Path(unquote(parsed.path))
    if not source.is_absolute():
        raise PortalFailure("invalid-response")

    try:
        source_stat = source.lstat()
    except OSError:
        raise PortalFailure("invalid-response")
    if stat.S_ISLNK(source_stat.st_mode) or not stat.S_ISREG(source_stat.st_mode):
        raise PortalFailure("invalid-response")

    return source


def copy_png(source, destination):
    temporary = destination.parent / (
        ".open-cluely-portal-" + secrets.token_hex(12) + ".tmp"
    )
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW

    try:
        file_descriptor = os.open(temporary, flags, 0o600)
        with os.fdopen(file_descriptor, "wb") as output_file:
            with source.open("rb") as input_file:
                shutil.copyfileobj(input_file, output_file)
            output_file.flush()
            os.fsync(output_file.fileno())

        with temporary.open("rb") as copied_file:
            signature = copied_file.read(len(PNG_SIGNATURE))
            copied_file.seek(0, os.SEEK_END)
            copied_size = copied_file.tell()
        if signature != PNG_SIGNATURE or copied_size <= len(PNG_SIGNATURE):
            raise PortalFailure("invalid-response")

        os.replace(temporary, destination)
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


def derive_request_path(connection, handle_token):
    unique_name = connection.get_unique_name()
    if not unique_name or not unique_name.startswith(":"):
        raise PortalFailure("portal-unavailable")
    sender_name = unique_name[1:].replace(".", "_")
    return (
        "/org/freedesktop/portal/desktop/request/"
        + sender_name
        + "/"
        + handle_token
    )


def remaining_timeout_ms(deadline):
    remaining_ms = int((deadline - time.monotonic()) * 1000)
    if remaining_ms <= 0:
        raise PortalFailure("portal-timeout")
    return max(1, remaining_ms)


def capture_request(connection, destination, interactive, deadline):
    handle_token = "open_cluely_" + secrets.token_hex(12)
    request_path = derive_request_path(connection, handle_token)
    main_loop = GLib.MainLoop.new(None, False)
    response_state = {"code": None, "uri": None, "timed_out": False}
    timeout_source_id = 0
    attempt_timeout_ms = remaining_timeout_ms(deadline)

    def on_response(
        _connection,
        _sender_name,
        _object_path,
        _interface_name,
        _signal_name,
        parameters,
        _user_data,
    ):
        response_code, results = parameters.unpack()
        response_state["code"] = int(response_code)
        if response_code == 0:
            uri_value = results.get("uri")
            if isinstance(uri_value, GLib.Variant):
                uri_value = uri_value.unpack()
            response_state["uri"] = uri_value
        main_loop.quit()

    def on_timeout():
        nonlocal timeout_source_id
        timeout_source_id = 0
        response_state["timed_out"] = True
        main_loop.quit()
        return GLib.SOURCE_REMOVE

    subscription_id = connection.signal_subscribe(
        PORTAL_BUS_NAME,
        REQUEST_INTERFACE,
        "Response",
        request_path,
        None,
        Gio.DBusSignalFlags.NONE,
        on_response,
        None,
    )
    timeout_source_id = GLib.timeout_add(attempt_timeout_ms, on_timeout)

    try:
        # An empty parent keeps any interactive consent UI portal-owned, so the
        # application window may remain hidden while the prompt is displayed.
        parameters = GLib.Variant(
            "(sa{sv})",
            (
                "",
                {
                    "handle_token": GLib.Variant("s", handle_token),
                    "interactive": GLib.Variant("b", bool(interactive)),
                },
            ),
        )
        try:
            reply = connection.call_sync(
                PORTAL_BUS_NAME,
                PORTAL_OBJECT_PATH,
                SCREENSHOT_INTERFACE,
                "Screenshot",
                parameters,
                GLib.VariantType.new("(o)"),
                Gio.DBusCallFlags.NONE,
                remaining_timeout_ms(deadline),
                None,
            )
        except Exception as error:
            if (
                GLib is not None
                and isinstance(error, GLib.Error)
                and error.matches(Gio.io_error_quark(), Gio.IOErrorEnum.TIMED_OUT)
            ):
                raise PortalFailure("portal-timeout")
            raise PortalFailure("portal-unavailable")

        returned_request_path = reply.unpack()[0]
        if returned_request_path != request_path:
            raise PortalFailure("invalid-response")

        if response_state["code"] is None and not response_state["timed_out"]:
            main_loop.run()
        if response_state["timed_out"]:
            try:
                connection.call(
                    PORTAL_BUS_NAME,
                    request_path,
                    REQUEST_INTERFACE,
                    "Close",
                    None,
                    None,
                    Gio.DBusCallFlags.NONE,
                    1_000,
                    None,
                    None,
                    None,
                )
            except Exception:
                pass
            raise PortalFailure("portal-timeout")

        response_code = response_state["code"]
        if response_code != 0:
            if response_code == 1:
                raise PortalFailure("cancelled")
            raise PortalFailure("permission-denied")

        source = response_uri_to_path(response_state["uri"])
        remaining_timeout_ms(deadline)
        copy_png(source, destination)
        try:
            remaining_timeout_ms(deadline)
        except PortalFailure:
            try:
                destination.unlink(missing_ok=True)
            except OSError:
                pass
            raise
    finally:
        try:
            if timeout_source_id:
                GLib.source_remove(timeout_source_id)
        except Exception:
            pass
        try:
            connection.signal_unsubscribe(subscription_id)
        except Exception:
            pass


def capture_with_permission_retry(
    connection,
    destination,
    deadline,
    attempt_capture=capture_request,
):
    try:
        return attempt_capture(connection, destination, False, deadline)
    except PortalFailure as error:
        if error.code != "permission-denied":
            raise

    remaining_timeout_ms(deadline)
    return attempt_capture(connection, destination, True, deadline)


def capture(destination, timeout_ms):
    if Gio is None or GLib is None:
        raise PortalFailure("portal-unavailable")

    deadline = time.monotonic() + (timeout_ms / 1000)
    try:
        connection = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    except Exception:
        raise PortalFailure("portal-unavailable")

    remaining_timeout_ms(deadline)
    capture_with_permission_retry(connection, destination, deadline)


def main(argv):
    if len(argv) not in (2, 3):
        return emit_status(
            False,
            "invalid-arguments",
            "A validated PNG destination is required.",
            2,
        )

    try:
        destination = validate_destination(argv[1])
        timeout_ms = parse_timeout(argv[2] if len(argv) == 3 else None)
        capture(destination, timeout_ms)
    except PortalFailure as error:
        messages = {
            "invalid-arguments": "Screenshot helper arguments are invalid.",
            "invalid-destination": "Screenshot destination is invalid.",
            "portal-unavailable": "Screenshot portal is unavailable.",
            "portal-timeout": "Screenshot portal timed out.",
            "cancelled": "Screenshot request was cancelled.",
            "permission-denied": "Screenshot permission was denied.",
            "invalid-response": "Screenshot portal returned invalid output.",
        }
        exit_codes = {
            "invalid-arguments": 2,
            "invalid-destination": 2,
            "portal-unavailable": 3,
            "portal-timeout": 4,
            "cancelled": 5,
            "permission-denied": 6,
            "invalid-response": 7,
        }
        return emit_status(
            False,
            error.code,
            messages.get(error.code, "Screenshot portal failed."),
            exit_codes.get(error.code, 1),
        )
    except Exception:
        return emit_status(
            False,
            "portal-failed",
            "Screenshot portal failed.",
            1,
        )

    return emit_status(
        True,
        "ok",
        "Screenshot captured.",
        0,
    )


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
