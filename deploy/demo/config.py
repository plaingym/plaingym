#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Preflight with Ubuntu's standard library; no pip, Node or SDK on the VPS."""
import argparse
import datetime
import getpass
import hashlib
import hmac
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import socket
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request


IMAGE = r"[a-zA-Z0-9][a-zA-Z0-9._:/-]*(?::v?\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?|@sha256:[a-f0-9]{64})"
HOST = r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?"
INPUTS = ("GYM_HOSTNAME", "ACME_EMAIL", "APP_IMAGE", "CADDY_IMAGE", "CLOUDFLARE_API_TOKEN",
          "UPLOADS_S3_ENDPOINT", "UPLOADS_S3_BUCKET", "UPLOADS_S3_ACCESS_KEY_ID", "UPLOADS_S3_SECRET_ACCESS_KEY")
LABELS = ("Demo domain", "ACME email", "App image (version or digest)", "Cloudflare Caddy image (version or digest)",
          "Cloudflare DNS API token", "S3 endpoint", "S3 bucket", "S3 access key", "S3 secret key")
SECRET_INPUTS = {"CLOUDFLARE_API_TOKEN", "UPLOADS_S3_ACCESS_KEY_ID", "UPLOADS_S3_SECRET_ACCESS_KEY"}


def read_env(path):
    if not path.exists():
        return {}
    result = {}
    for line in path.read_text().splitlines():
        if "=" in line and not line.startswith("#"):
            key, value = line.split("=", 1)
            result[key] = value
    if result.get("DEMO_INSTALL") != "1":
        raise ValueError("This directory belongs to another installation; choose a demo directory.")
    return result


def validate(config):
    local = config["DEMO_LOCAL_TEST"] == "true"
    domain = config["GYM_HOSTNAME"]
    if len(domain) > 253 or not re.fullmatch(HOST, domain):
        raise ValueError("Use a lowercase DNS hostname without a URL or port.")
    if local and not domain.endswith((".test", ".localhost")):
        raise ValueError("Local tests require a .test or .localhost domain.")
    if not re.fullmatch(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}", config["ACME_EMAIL"]):
        raise ValueError("An ACME contact email is required.")
    for key in ("APP_IMAGE", "CADDY_IMAGE"):
        if not re.fullmatch(IMAGE, config[key]):
            raise ValueError(f"{key} requires an explicit version or sha256 digest.")
    for key in INPUTS:
        if not config[key] or not re.fullmatch(r"[a-zA-Z0-9@._:/+=%-]+", config[key]):
            raise ValueError(f"{key} must be a single line with no shell or Compose interpolation characters.")
    endpoint = urllib.parse.urlsplit(config["UPLOADS_S3_ENDPOINT"])
    if (endpoint.scheme not in (("http", "https") if local else ("https",)) or not endpoint.hostname
            or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment or endpoint.path not in ("", "/")):
        raise ValueError("S3 endpoint must be an HTTPS origin (HTTP allowed only in local tests).")
    if not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", config["UPLOADS_S3_BUCKET"]):
        raise ValueError("Invalid S3 bucket name.")
    if not re.fullmatch(r"[a-z0-9-]+", config["UPLOADS_S3_REGION"]):
        raise ValueError("Invalid S3 region.")
    if not re.fullmatch(r"https://[a-zA-Z0-9./_-]+", config["ACME_CA"]):
        raise ValueError("ACME_CA must be an HTTPS directory URL.")
    if not re.fullmatch(r"[1-9][0-9]*", config.get("DEMO_SNAPSHOT_RETENTION", "3")):
        raise ValueError("Snapshot retention must be a positive integer.")


def request(url, method="GET", body=None, headers=None):
    req = urllib.request.Request(url, data=body, headers=headers or {}, method=method)
    # No redirects: never forward API credentials to a different destination.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, hdrs, newurl):
            return None
    with urllib.request.build_opener(NoRedirect).open(req, timeout=15) as response:
        return response.read()


def dns_check(config):
    addresses = set()
    interfaces = json.loads(subprocess.check_output(["ip", "-j", "address", "show"], text=True))
    for interface in interfaces:
        for address in interface.get("addr_info", []):
            value = ipaddress.ip_address(address["local"])
            if value.is_global:
                addresses.add(str(value))
    # Covers providers that NAT the public address. No operator-supplied IP needed.
    for endpoint in ("https://api.ipify.org", "https://api6.ipify.org"):
        try:
            addresses.add(str(ipaddress.ip_address(request(endpoint).decode().strip())))
        except (OSError, ValueError):
            pass
    if not addresses:
        raise ValueError("Could not discover this server's public IP address.")
    for host in (config["GYM_HOSTNAME"], secrets.token_hex(6) + "." + config["GYM_HOSTNAME"]):
        resolved = {row[4][0] for row in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)}
        if not resolved or not resolved.issubset(addresses):
            raise ValueError("Both base and wildcard DNS must point directly at this server (Cloudflare DNS only, including AAAA).")


def cloudflare_check(config, base="https://api.cloudflare.com/client/v4"):
    headers = {"Authorization": "Bearer " + config["CLOUDFLARE_API_TOKEN"], "Content-Type": "application/json"}

    def api(path, method="GET", body=None):
        data = json.loads(request(base + path, method, json.dumps(body).encode() if body is not None else None, headers))
        if not data.get("success"):
            raise ValueError("Cloudflare refused the DNS check; check Zone Read and DNS Edit permissions.")
        return data.get("result")

    labels = config["GYM_HOSTNAME"].split(".")
    zone = None
    for index in range(len(labels) - 1):
        zones = api("/zones?name=" + ".".join(labels[index:]))
        if zones:
            zone = zones[0]["id"]
            break
    if not zone:
        raise ValueError("The token cannot read the demo's Cloudflare zone.")
    path = f"/zones/{zone}/dns_records"
    # An actual create/delete proves write access; token verification alone does not.
    record = api(path, "POST", {"type": "TXT", "name": "_plaingym-check-" + secrets.token_hex(6) + "." + config["GYM_HOSTNAME"],
                                "content": secrets.token_hex(16), "ttl": 60})
    api(path + "/" + record["id"], "DELETE")


def s3_request(config, method, key, body=b""):
    """AWS SigV4, path-style, same endpoint/region as the runtime S3 adapter."""
    now = datetime.datetime.now(datetime.timezone.utc)
    stamp, date = now.strftime("%Y%m%dT%H%M%SZ"), now.strftime("%Y%m%d")
    endpoint = urllib.parse.urlsplit(config["UPLOADS_S3_ENDPOINT"])
    path = "/" + config["UPLOADS_S3_BUCKET"] + "/" + urllib.parse.quote(key, safe="/-_.~")
    payload_hash = hashlib.sha256(body).hexdigest()
    canonical_headers = f"host:{endpoint.netloc}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{stamp}\n"
    signed_headers = "host;x-amz-content-sha256;x-amz-date"
    canonical = "\n".join((method, path, "", canonical_headers, signed_headers, payload_hash))
    region = config["UPLOADS_S3_REGION"]
    scope = f"{date}/{region}/s3/aws4_request"
    string_to_sign = "\n".join(("AWS4-HMAC-SHA256", stamp, scope, hashlib.sha256(canonical.encode()).hexdigest()))
    signing_key = ("AWS4" + config["UPLOADS_S3_SECRET_ACCESS_KEY"]).encode()
    for part in (date, region, "s3", "aws4_request"):
        signing_key = hmac.new(signing_key, part.encode(), hashlib.sha256).digest()
    signature = hmac.new(signing_key, string_to_sign.encode(), hashlib.sha256).hexdigest()
    headers = {"x-amz-content-sha256": payload_hash, "x-amz-date": stamp, "Content-Type": "application/octet-stream",
               "Authorization": f"AWS4-HMAC-SHA256 Credential={config['UPLOADS_S3_ACCESS_KEY_ID']}/{scope}, SignedHeaders={signed_headers}, Signature={signature}"}
    return request(f"{endpoint.scheme}://{endpoint.netloc}{path}", method, body if method == "PUT" else None, headers)


def s3_check(config):
    key, body = "plaingym-preflight/" + secrets.token_hex(16), secrets.token_bytes(32)
    s3_request(config, "PUT", key, body)
    try:
        if s3_request(config, "GET", key) != body:
            raise ValueError("S3 test read did not match its test write.")
    finally:
        s3_request(config, "DELETE", key)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--existing", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--check-only", action="store_true")
    args = parser.parse_args()
    existing = read_env(args.existing)
    config = dict(existing)
    config["DEMO_LOCAL_TEST"] = os.environ.get("DEMO_LOCAL_TEST", "false")
    if existing and config["DEMO_LOCAL_TEST"] != existing.get("DEMO_LOCAL_TEST"):
        raise ValueError("An installation cannot switch between local and public TLS.")
    for key, label in zip(INPUTS, LABELS):
        value = existing.get(key) or os.environ.get(key)
        if not value:
            if not sys.stdin.isatty() and not Path("/dev/tty").exists():
                raise ValueError(f"Missing {key}; use an interactive terminal or set it in the environment.")
            if key in SECRET_INPUTS:
                value = getpass.getpass(label + ": ")
            else:
                with open("/dev/tty", "r+") as terminal:
                    terminal.write(label + ": ")
                    terminal.flush()
                    value = terminal.readline().strip()
        config[key] = value
    config.setdefault("UPLOADS_S3_REGION", os.environ.get("UPLOADS_S3_REGION", "auto"))
    config.setdefault("ACME_CA", os.environ.get("ACME_CA", "https://acme-v02.api.letsencrypt.org/directory"))
    config.setdefault("DEMO_SNAPSHOT_RETENTION", os.environ.get("DEMO_SNAPSHOT_RETENTION", "3"))
    validate(config)
    if config["DEMO_LOCAL_TEST"] != "true":
        dns_check(config)
        cloudflare_check(config)
    s3_check(config)
    print("Preflight passed: inputs and S3 write/read/delete" + ("; local DNS/TLS stand-in." if config["DEMO_LOCAL_TEST"] == "true" else ", base/wildcard DNS and Cloudflare DNS edit."))
    if args.check_only:
        return
    if not args.output:
        raise ValueError("Missing output file.")
    if not existing:
        config.update(DEMO_INSTALL="1", COMPOSE_PROJECT_NAME="plaingym-demo", POSTGRES_DB="plaingym", BACKUP_RECIPIENT="")
        for key in ("POSTGRES_PASSWORD", "APP_PASSWORD", "MAINTENANCE_PASSWORD", "APP_ENCRYPTION_KEY", "AUTH_SECRET", "SETUP_TOKEN"):
            config[key] = secrets.token_hex(32)
    # The shell helper deliberately reads literal single-line values without eval/source.
    args.output.write_text("# SPDX-License-Identifier: AGPL-3.0-only\n" + "".join(f"{key}={value}\n" for key, value in config.items()))
    args.output.chmod(0o600)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError) as error:
        # API responses and request headers can contain credentials. Never echo them.
        print("Demo preflight failed: " + (str(error) if isinstance(error, ValueError) else type(error).__name__) + ". Check DNS, token scope and bucket credentials; no host configuration was changed.", file=sys.stderr)
        sys.exit(1)
