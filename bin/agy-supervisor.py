#!/usr/bin/env python3
import sys
import os
import subprocess
import json
import re
import time
import threading

real_home = os.environ.get("REAL_HOME") or os.path.expanduser("~")
if "/.agy-profiles/" in real_home:
    real_home = real_home.split("/.agy-profiles/")[0]
PROFILES_BASE = os.path.join(real_home, ".agy-profiles")

script_dir = os.path.dirname(os.path.abspath(__file__))
bin_candidate = os.path.join(script_dir, "agy.bin")
if not os.path.exists(bin_candidate):
    bin_candidate = os.path.join(real_home, ".local/bin/agy.bin")
AGY_BIN = bin_candidate if os.path.exists(bin_candidate) else "agy.bin"

def get_other_profile(current):
    return "pufaysokt" if current == "oktaya" else "oktaya"

def is_quota_error(text):
    if not text:
        return False
    t = str(text).lower()
    return any(k in t for k in ["resource_exhausted", "code 429", "quota reached", "capacity exhausted", "quota exceeded"])

def check_quota_exhausted(frame, raw_line):
    if isinstance(frame, dict):
        event_type = frame.get("event")
        if event_type == "result":
            res = frame.get("result", {})
            if res.get("status") == "ERROR" and is_quota_error(res.get("error", "")):
                return True
        elif event_type == "error":
            if is_quota_error(frame.get("error", "")):
                return True
    return is_quota_error(raw_line)

def run_supervisor(initial_profile, cmd_args):
    current_profile = initial_profile
    conversation_id = None
    child_lock = threading.Lock()
    recent_stderr = []

    # Extract conversation_id if passed in args
    for i, a in enumerate(cmd_args):
        if a == "--conversation" and i + 1 < len(cmd_args):
            conversation_id = cmd_args[i + 1]
            break

    env = os.environ.copy()
    env["HOME"] = os.path.join(PROFILES_BASE, current_profile)

    child = subprocess.Popen(
        [AGY_BIN] + cmd_args,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
        env=env
    )

    last_user_message = None
    streamed_frames_for_turn = []

    def drain_stderr(proc):
        nonlocal recent_stderr
        for line in proc.stderr:
            sys.stderr.write(line)
            sys.stderr.flush()
            recent_stderr.append(line)
            if len(recent_stderr) > 30:
                recent_stderr.pop(0)

    stderr_thread = threading.Thread(target=drain_stderr, args=(child,), daemon=True)
    stderr_thread.start()

    # Thread to read stdin from Paseo and write to child
    def stdin_loop():
        nonlocal last_user_message
        try:
            for line in sys.stdin:
                try:
                    data = json.loads(line)
                    if data.get("event") == "user":
                        last_user_message = line
                        streamed_frames_for_turn.clear()
                except Exception:
                    pass
                with child_lock:
                    if child and child.stdin and not child.stdin.closed:
                        try:
                            child.stdin.write(line)
                            child.stdin.flush()
                        except Exception:
                            pass
        except (BrokenPipeError, IOError):
            pass

    stdin_thread = threading.Thread(target=stdin_loop, daemon=True)
    stdin_thread.start()

    def do_relaunch(reason="Quota exhausted"):
        nonlocal child, current_profile
        next_profile = get_other_profile(current_profile)
        sys.stderr.write(f"\n[agy-supervisor] {reason} on {current_profile}. Automatically switching session to {next_profile}...\n")
        sys.stderr.flush()

        with child_lock:
            try:
                child.terminate()
                child.wait(timeout=2)
            except Exception:
                child.kill()

            current_profile = next_profile
            env["HOME"] = os.path.join(PROFILES_BASE, current_profile)

            new_args = list(cmd_args)
            if conversation_id and "--conversation" not in new_args:
                new_args.extend(["--conversation", conversation_id])

            child = subprocess.Popen(
                [AGY_BIN] + new_args,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
                env=env
            )
            threading.Thread(target=drain_stderr, args=(child,), daemon=True).start()

            # Discard duplicate init frame since Paseo already initialized session
            child.stdout.readline()

            if last_user_message and child.stdin:
                child.stdin.write(last_user_message)
                child.stdin.flush()

    while True:
        line = child.stdout.readline()
        if not line:
            rc = child.poll()
            if rc is not None:
                # Check if process exited due to quota exhaustion
                if last_user_message and any(is_quota_error(err) for err in recent_stderr):
                    do_relaunch("Process exited with quota limit")
                    continue
                break
            continue

        try:
            frame = json.loads(line)
            event_type = frame.get("event")

            if check_quota_exhausted(frame, line):
                do_relaunch("Quota exhausted")
                continue

            if event_type == "init":
                if not conversation_id:
                    conversation_id = frame.get("conversation_id")
                sys.stdout.write(line)
                sys.stdout.flush()
                continue

            if event_type == "step_update":
                streamed_frames_for_turn.append(line)
                sys.stdout.write(line)
                sys.stdout.flush()
                continue

            if event_type == "result":
                sys.stdout.write(line)
                sys.stdout.flush()
                last_user_message = None
                continue

            # Any other frame
            sys.stdout.write(line)
            sys.stdout.flush()

        except json.JSONDecodeError:
            if is_quota_error(line):
                do_relaunch("Raw quota error")
                continue
            sys.stdout.write(line)
            sys.stdout.flush()

    child.wait()
    sys.exit(child.returncode)

if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit(1)
    prof = sys.argv[1]
    args = sys.argv[2:]
    run_supervisor(prof, args)
