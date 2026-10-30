#!/usr/bin/env python3
"""Apply a verified helper image without replacing Homey or its data volume."""
import argparse
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import time

PROJECT = "homey-eufy-media-helper"
LABEL = "io.metalcated.eufy-media"


class UpdateError(Exception):
    pass


def command(argv, check=True):
    result = subprocess.run(argv, capture_output=True, text=True, timeout=90)
    if check and result.returncode:
        raise UpdateError("Container command failed: " + argv[1])
    return result


def atomic(path, value):
    if path.is_symlink():
        raise UpdateError("Refusing a symbolic link in helper configuration")
    temporary = path.with_name(path.name + "." + secrets.token_hex(8) + ".new")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as target:
        target.write(value)
    os.replace(temporary, path)


def environment(path):
    values = {}
    for line in path.read_text().splitlines():
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.partition("=")
        if not separator or not re.fullmatch(r"EUFY_MEDIA_[A-Z_]+", key) or any(c in value for c in "\r\n\x00"):
            raise UpdateError("Invalid helper environment entry")
        values[key] = value
    if values.get("EUFY_MEDIA_PROJECT_NAME") != PROJECT or values.get("EUFY_MEDIA_CONTAINER_NAME") != PROJECT:
        raise UpdateError("Only the dedicated helper project may be managed")
    if values.get("EUFY_MEDIA_DATA_VOLUME") != PROJECT + "-data":
        raise UpdateError("Only the dedicated helper data volume may be mounted")
    port = values.get("EUFY_MEDIA_PORT", "8769")
    if not port.isdigit() or not 1024 <= int(port) <= 65535:
        raise UpdateError("Invalid helper loopback port")
    return values


def save_environment(path, values):
    atomic(path, "".join(f"{key}={value}\n" for key, value in sorted(values.items())))


def image_identity(reference):
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_./:@-]{0,239}", reference):
        raise UpdateError("Invalid helper image reference")
    info = json.loads(command(["docker", "image", "inspect", reference]).stdout)[0]
    labels = info.get("Config", {}).get("Labels") or {}
    if labels.get(LABEL + ".protocol") != "1" or labels.get(LABEL + ".sdk") != "4.2.6":
        raise UpdateError("The image does not support this app/helper protocol")
    if not re.fullmatch(r"\d+\.\d+\.\d+", labels.get(LABEL + ".version", "")):
        raise UpdateError("The helper release version is missing")
    if info.get("Os") != "linux" or info.get("Architecture") != "amd64":
        raise UpdateError("This deployment requires a Linux amd64 helper image")
    return info["Id"], labels[LABEL + ".version"]


def existing_container():
    result = command(["docker", "container", "inspect", PROJECT], check=False)
    if result.returncode:
        return None
    info = json.loads(result.stdout)[0]
    labels = info.get("Config", {}).get("Labels") or {}
    if labels.get("com.docker.compose.project") != PROJECT or labels.get("com.docker.compose.service") != "media-helper":
        raise UpdateError("The target name belongs to a different container")
    return {"imageId": info["Image"], "status": info.get("State", {}).get("Status")}


def initialize_volume(seed):
    name = PROJECT + "-data"
    result = command(["docker", "volume", "inspect", name], check=False)
    if result.returncode:
        command(["docker", "volume", "create", "--label", LABEL + "=true", name])
        result = command(["docker", "volume", "inspect", name])
    volume = json.loads(result.stdout)[0]
    if (volume.get("Labels") or {}).get(LABEL) != "true":
        raise UpdateError("The persistent volume belongs to a different application")
    mount = Path(volume["Mountpoint"])
    target = mount / "auth.key"
    if target.is_symlink():
        raise UpdateError("Invalid helper key location")
    if target.exists():
        key = target.read_text().strip()
        if seed and not secrets.compare_digest(key, seed.read_text().strip()):
            raise UpdateError("Existing helper identity differs; nothing changed")
    else:
        if not seed or seed.is_symlink() or seed.stat().st_mode & 0o077:
            raise UpdateError("A private bootstrap key file is required for first installation")
        key = seed.read_text().strip()
        if not re.fullmatch(r"[a-f0-9]{64}", key):
            raise UpdateError("Invalid bootstrap key format")
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as output:
            output.write(key + "\n")
    if not re.fullmatch(r"[a-f0-9]{64}", key):
        raise UpdateError("Invalid persistent helper key")
    os.chown(mount, 1000, 1000)
    os.chmod(mount, 0o700)
    os.chown(target, 1000, 1000)
    os.chmod(target, 0o600)
    return hashlib.sha256(key.encode()).hexdigest()


def compose(root, *arguments):
    return command(["docker", "compose", "--env-file", str(root / "runtime.env"),
                    "-f", str(root / "compose.yaml"), "--project-name", PROJECT, *arguments])


def wait_healthy(expected, timeout):
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        current = existing_container()
        if current and current["imageId"] == expected and current["status"] == "running":
            result = command(["docker", "exec", PROJECT, "node", "healthcheck.cjs"], check=False)
            if not result.returncode:
                return
        time.sleep(2)
    raise UpdateError("The helper did not pass its authenticated health check")


def apply(args):
    root = args.root.resolve()
    if not root.is_dir() or not (root / "compose.yaml").is_file():
        raise UpdateError("Helper deployment files are missing")
    if os.geteuid() != 0:
        raise UpdateError("Run on the VM as root to initialize and verify the private helper volume")
    expected = args.image_id
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", expected):
        raise UpdateError("An exact expected image identity is required")
    actual, version = image_identity(args.image)
    if actual != expected:
        raise UpdateError("The image differs from the reviewed release")
    old = existing_container()
    if not (root / "runtime.env").exists():
        if old:
            raise UpdateError("Existing helper configuration is missing")
        atomic(root / "runtime.env", (root / "example.env").read_text())
    values = environment(root / "runtime.env")
    identity = initialize_volume(args.seed_token)
    old_values = dict(values)
    values["EUFY_MEDIA_IMAGE"] = actual
    releases = root / "releases"
    releases.mkdir(mode=0o700, exist_ok=True)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + secrets.token_hex(4)
    backup = {"at": stamp, "previous": old, "environment": old_values, "keyFingerprint": identity}
    atomic(releases / (stamp + "-before.json"), json.dumps(backup, indent=2) + "\n")
    try:
        save_environment(root / "runtime.env", values)
        compose(root, "config", "--quiet")
        compose(root, "up", "-d", "--no-build", "--force-recreate")
        wait_healthy(expected, args.health_timeout)
    except Exception as error:
        if old:
            old_values["EUFY_MEDIA_IMAGE"] = old["imageId"]
            save_environment(root / "runtime.env", old_values)
            compose(root, "up", "-d", "--no-build", "--force-recreate")
            wait_healthy(old["imageId"], args.health_timeout)
            raise UpdateError("Update failed; the previous helper image and configuration were restored") from error
        raise UpdateError("First installation failed; private data and release records were retained") from error
    release = {"at": stamp, "image": args.image, "imageId": actual, "version": version,
               "protocol": 1, "sdk": "4.2.6", "keyFingerprint": identity, "healthy": True}
    atomic(root / "current-release.json", json.dumps(release, indent=2) + "\n")
    atomic(releases / (stamp + "-accepted.json"), json.dumps(release, indent=2) + "\n")
    print(json.dumps({"updated": True, "version": version, "protocol": 1, "healthy": True,
                      "persistentIdentityPreserved": True, "imageId": actual}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument("--image", required=True)
    parser.add_argument("--image-id", required=True)
    parser.add_argument("--seed-token", type=Path)
    parser.add_argument("--health-timeout", type=int, default=60)
    args = parser.parse_args()
    if not 5 <= args.health_timeout <= 120:
        raise UpdateError("Health deadline must be between 5 and 120 seconds")
    root = args.root.resolve()
    if not root.is_dir():
        raise UpdateError("Helper deployment directory is missing")
    lock = os.open(root / ".update.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise UpdateError("Another helper update is already in progress") from error
        apply(args)
    finally:
        os.close(lock)


if __name__ == "__main__":
    try:
        main()
    except (UpdateError, OSError, subprocess.TimeoutExpired, ValueError, KeyError) as error:
        message = str(error) if isinstance(error, UpdateError) else "The helper operation could not finish"
        print(json.dumps({"updated": False, "error": message}), file=sys.stderr)
        sys.exit(1)
