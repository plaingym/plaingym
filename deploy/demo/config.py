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
BILLING_KEY, BILLING_SECRET = "DEMO_STRIPE_TEST_KEY", "DEMO_STRIPE_WEBHOOK_SECRET"
SECRET_INPUTS = {"CLOUDFLARE_API_TOKEN", "UPLOADS_S3_ACCESS_KEY_ID", "UPLOADS_S3_SECRET_ACCESS_KEY"}
# The gym installer's pinned list of Cloudflare's proxy addresses, shipped in the same bundle.
CLOUDFLARE_RANGES = Path(__file__).resolve().parent.parent / "cloudflare-ranges.txt"


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


def validate_billing(config):
    """Same patterns as the app's demo boot check (apps/server/src/demo/config.ts). Never echoes a value."""
    key, secret = config.get(BILLING_KEY, ""), config.get(BILLING_SECRET, "")
    if any(re.search(r"(?:sk|rk|pk)_live_", value, re.IGNORECASE) for value in (key, secret)):
        raise ValueError("Demo billing refuses live Stripe keys; use a test-mode key")
    if not key and not secret:
        return
    if not re.fullmatch(r"(?:sk|rk)_test_[A-Za-z0-9]+", key):
        raise ValueError(f"{BILLING_KEY} requires a Stripe test-mode secret or restricted key (sk_test_ or rk_test_)")
    if not re.fullmatch(r"whsec_[A-Za-z0-9]+", secret):
        raise ValueError(f"{BILLING_SECRET} must be the endpoint's whsec_ signing secret, set together with the key")


def has_terminal():
    if sys.stdin.isatty():
        return True
    try:
        with open("/dev/tty"):
            return True
    except OSError:
        return False  # present but unusable without a controlling terminal (CI, containers)


def prompt(label, secret=False):
    if secret:
        return getpass.getpass(label + ": ")
    # Buffered read/write mode requires seeking, which a terminal cannot do.
    # Separate streams also keep prompts independent of piped bootstrap stdin.
    with open("/dev/tty", "w") as output, open("/dev/tty", "r") as terminal:
        output.write(label + ": ")
        output.flush()
        return terminal.readline().strip()


def billing_inputs(config, ask):
    """Keep saved values; else take both from the environment; else (interactive only) ask once, default no.

    A billing variable set in the environment, even empty, answers the question, so a scripted run with a terminal
    (an SSH session, test-local.sh) never stops at it: set both values, or DEMO_STRIPE_TEST_KEY= to skip billing.
    """
    if config.get(BILLING_KEY):
        if not config.get(BILLING_SECRET):
            # A key saved by hand without its secret: complete it from the environment or a hidden prompt. A
            # billing variable set in the environment, even empty, answers here too, so a scripted run never waits.
            secret = os.environ.get(BILLING_SECRET, "").strip()
            if not secret and not any(name in os.environ for name in (BILLING_KEY, BILLING_SECRET)) and ask and has_terminal():
                secret = prompt("Stripe webhook signing secret (whsec_)", True).strip()
            config[BILLING_SECRET] = secret
        return
    values = {name: os.environ.get(name, "") for name in (BILLING_KEY, BILLING_SECRET)}
    if not any(values.values()):
        if any(name in os.environ for name in values) or not ask or not has_terminal() \
                or prompt("Set up demo billing with a Stripe test key? [y/N]").lower() not in ("y", "yes"):
            return
        values = {BILLING_KEY: prompt("Stripe test secret key (sk_test_ or rk_test_)", True).strip(),
                  BILLING_SECRET: prompt("Stripe webhook signing secret (whsec_)", True).strip()}
        if not any(values.values()):
            raise ValueError("Demo billing was chosen but no key or secret was entered; nothing was written")
    config.update(values)


def request(url, method="GET", body=None, headers=None):
    req = urllib.request.Request(url, data=body, headers=headers or {}, method=method)
    # No redirects: never forward API credentials to a different destination.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, hdrs, newurl):
            return None
    with urllib.request.build_opener(NoRedirect).open(req, timeout=15) as response:
        return response.read()


def cloudflare_networks(path=CLOUDFLARE_RANGES):
    networks = [ipaddress.ip_network(line.strip()) for line in path.read_text().splitlines()
                if line.strip() and not line.lstrip().startswith("#")]
    if not networks:
        raise ValueError("The bundle's Cloudflare address list is empty.")
    return networks


def dns_check(config):
    """Both names must resolve only to this server (DNS only) or only to Cloudflare's proxy, the same way.

    Returns True when they are proxied. The proxy hides the server's address, so then the DNS check can't
    tell which server is behind it; the demo prints no private link, and the HTTPS health check that follows
    goes through the hostname.
    """
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
    networks = cloudflare_networks()
    modes = set()
    for host in (config["GYM_HOSTNAME"], secrets.token_hex(6) + "." + config["GYM_HOSTNAME"]):
        resolved = {row[4][0] for row in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)}
        if resolved and resolved.issubset(addresses):
            modes.add("direct")
        elif resolved and all(any(ipaddress.ip_address(value) in network for network in networks) for value in resolved):
            modes.add("proxied")
        else:
            raise ValueError("Both base and wildcard DNS must point at this server, DNS only or through Cloudflare's proxy (including AAAA).")
    if len(modes) > 1:
        raise ValueError("Proxy both the base and wildcard records through Cloudflare, or neither.")
    return modes == {"proxied"}


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


def s3_request(config, method, key, body=b"", query=None, headers=None):
    """AWS SigV4, path-style, same endpoint/region as the runtime S3 adapter.

    An empty key addresses the bucket itself (a listing). `query` is signed; extra `headers` are sent unsigned.
    """
    now = datetime.datetime.now(datetime.timezone.utc)
    stamp, date = now.strftime("%Y%m%dT%H%M%SZ"), now.strftime("%Y%m%d")
    endpoint = urllib.parse.urlsplit(config["UPLOADS_S3_ENDPOINT"])
    path = "/" + config["UPLOADS_S3_BUCKET"] + ("/" + urllib.parse.quote(key, safe="/-_.~") if key else "")
    query_string = "&".join(urllib.parse.quote(name, safe="-_.~") + "=" + urllib.parse.quote(value, safe="-_.~")
                            for name, value in sorted((query or {}).items()))
    payload_hash = hashlib.sha256(body).hexdigest()
    canonical_headers = f"host:{endpoint.netloc}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{stamp}\n"
    signed_headers = "host;x-amz-content-sha256;x-amz-date"
    canonical = "\n".join((method, path, query_string, canonical_headers, signed_headers, payload_hash))
    region = config["UPLOADS_S3_REGION"]
    scope = f"{date}/{region}/s3/aws4_request"
    string_to_sign = "\n".join(("AWS4-HMAC-SHA256", stamp, scope, hashlib.sha256(canonical.encode()).hexdigest()))
    signing_key = ("AWS4" + config["UPLOADS_S3_SECRET_ACCESS_KEY"]).encode()
    for part in (date, region, "s3", "aws4_request"):
        signing_key = hmac.new(signing_key, part.encode(), hashlib.sha256).digest()
    signature = hmac.new(signing_key, string_to_sign.encode(), hashlib.sha256).hexdigest()
    sent = {"x-amz-content-sha256": payload_hash, "x-amz-date": stamp, "Content-Type": "application/octet-stream",
            "Authorization": f"AWS4-HMAC-SHA256 Credential={config['UPLOADS_S3_ACCESS_KEY_ID']}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
            **(headers or {})}
    url = f"{endpoint.scheme}://{endpoint.netloc}{path}" + ("?" + query_string if query_string else "")
    return request(url, method, body if method in ("PUT", "POST") else None, sent)


def s3_check(config):
    """Every kind of request the app's storage adapter makes (apps/server/src/infra/storage/s3.ts), in a private
    preflight prefix, so credentials or storage that can't serve one fail here rather than at the first sandbox:
    write, read, metadata (HEAD), listing, a conditional write that must refuse to overwrite, a multipart upload
    (started and aborted) and delete. Everything written is deleted again."""
    prefix = "plaingym-preflight/" + secrets.token_hex(16) + "/"
    key, guarded, multipart, body = prefix + "object", prefix + "guarded", prefix + "multipart", secrets.token_bytes(32)
    written = []

    def step(name, *args, **kwargs):
        try:
            return s3_request(config, *args, **kwargs)
        except urllib.error.HTTPError as error:
            raise ValueError(f"S3 refused the test {name} (HTTP {error.code}). The credentials need object read, write, "
                             "list and delete on the bucket.") from None
    try:
        step("write", "PUT", key, body)
        written.append(key)
        if step("read", "GET", key) != body:
            raise ValueError("S3 test read did not match its test write.")
        step("metadata read (HEAD)", "HEAD", key)
        if key.encode() not in step("listing", "GET", "", query={"list-type": "2", "prefix": prefix, "max-keys": "10"}):
            raise ValueError("S3 test listing did not include the test object.")
        step("conditional write", "PUT", guarded, body, headers={"If-None-Match": "*"})
        written.append(guarded)
        try:
            s3_request(config, "PUT", guarded, body, headers={"If-None-Match": "*"})
        except urllib.error.HTTPError as error:
            if error.code != 412:
                raise ValueError(f"S3 answered a repeated conditional write with HTTP {error.code}, not 412.") from None
        else:
            raise ValueError("S3 overwrote an object despite If-None-Match; the app needs storage that honours conditional writes.")
        started = re.search(rb"<UploadId>([^<]+)</UploadId>", step("multipart upload", "POST", multipart, query={"uploads": ""}))
        if not started:
            raise ValueError("S3 did not start the test multipart upload.")
        step("multipart abort", "DELETE", multipart, query={"uploadId": started.group(1).decode()})
    finally:
        for name in written:
            step("delete", "DELETE", name)


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
            if not has_terminal():
                raise ValueError(f"Missing {key}; use an interactive terminal or set it in the environment.")
            value = prompt(label, key in SECRET_INPUTS)
        config[key] = value
    config.setdefault("UPLOADS_S3_REGION", os.environ.get("UPLOADS_S3_REGION", "auto"))
    config.setdefault("ACME_CA", os.environ.get("ACME_CA", "https://acme-v02.api.letsencrypt.org/directory"))
    config.setdefault("DEMO_SNAPSHOT_RETENTION", os.environ.get("DEMO_SNAPSHOT_RETENTION", "3"))
    # The required inputs are validated and checked before the optional billing question, so a mistake in
    # them is reported before the operator types a key.
    validate(config)
    proxied = False
    if config["DEMO_LOCAL_TEST"] != "true":
        proxied = dns_check(config) is True
        cloudflare_check(config)
    s3_check(config)
    billing_inputs(config, ask=not args.check_only)
    validate_billing(config)
    # A proxied demo trusts Cloudflare's visitor header (on requests from Cloudflare's addresses only). A saved
    # value, even false, is the operator's and stays; install.sh adds this one to an older install's .env.
    if proxied and "TRUST_CLOUDFLARE" not in config:
        config["TRUST_CLOUDFLARE"] = "true"
    print("Preflight passed: inputs and S3 storage" + ("; local DNS/TLS stand-in." if config["DEMO_LOCAL_TEST"] == "true" else ", base/wildcard DNS" + (" (through Cloudflare's proxy)" if proxied else "") + " and Cloudflare DNS edit."))
    if args.check_only:
        return
    if not args.output:
        raise ValueError("Missing output file.")
    if not existing:
        config.update(DEMO_INSTALL="1", COMPOSE_PROJECT_NAME="plaingym-demo", POSTGRES_DB="plaingym")
        for key in ("POSTGRES_PASSWORD", "APP_PASSWORD", "MAINTENANCE_PASSWORD", "APP_ENCRYPTION_KEY", "AUTH_SECRET", "SETUP_TOKEN"):
            config[key] = secrets.token_hex(32)
    # The shell helper deliberately reads literal single-line values without eval/source.
    args.output.write_text("# SPDX-License-Identifier: AGPL-3.0-only\n" + "".join(f"{key}={value}\n" for key, value in config.items()))
    args.output.chmod(0o600)


def cli():
    try:
        main()
    except (ValueError, OSError, KeyError, EOFError, KeyboardInterrupt) as error:
        # API responses and request headers can contain credentials. Never echo them.
        print("Demo preflight failed: " + (str(error) if isinstance(error, ValueError) else type(error).__name__) + ". Check DNS, token scope and bucket credentials; no host configuration was changed.", file=sys.stderr)
        sys.exit(130 if isinstance(error, KeyboardInterrupt) else 1)


if __name__ == "__main__":
    cli()
