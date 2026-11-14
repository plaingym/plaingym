<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Install PlainGym

This page puts PlainGym on a new server and ends with a private link to the setup
wizard. It assumes you have never used a server before. It takes about 30 minutes, plus
the time your domain's DNS needs to catch up.

You will end up with one server running your gym at an address such as
`https://gym.example.org`, with a valid HTTPS certificate. The server is yours: you pay
the hosting company for it, and nobody else can see the gym's data.

## What you need first

* **A domain name** you control, such as `example.org`, and the login to the company
  that manages its DNS (often the registrar, or Cloudflare). The gym will live at a
  name under it, such as `gym.example.org`.
* **A virtual private server (VPS)** from any hosting company: Ubuntu 24.04 or 26.04 LTS,
  amd64 or arm64, 2 GB of RAM recommended, and a public IPv4 address. When you create it,
  choose the Ubuntu image and note the server's IP address and how you log in (a password,
  or an SSH key you add on the provider's page).
* **An email address** for the certificate authority (Let's Encrypt) to warn you before a
  certificate expires. It isn't your sign-in address.
* **Later, in the setup wizard:** an email sending service, a Stripe account and an
  S3-compatible storage bucket for backups. All are listed under
  [what you need](self-hosting.md#what-you-need). You can install first and fill these in
  as you go, but set up backups before you rely on the gym: updates refuse to run without
  them.

## 1. Check the firewall at your provider

Some providers run a firewall outside the server. If yours does, allow TCP ports **80**
(web), **443** (secure web) and the port you log in on (**22**, SSH, unless you changed
it). The installer sets up the server's own firewall; it can't open one at the provider.

## 2. Point a name at the server

Your domain's DNS is the phone book that tells browsers which server holds
`gym.example.org`. In the DNS settings of your domain:

1. Add an **A record**. The name is `gym` (or whatever comes before your domain), and the
   value is the server's IPv4 address.
2. If the server also has a public IPv6 address you can reach, add an **AAAA record** with
   it. If you are not sure, leave it out: a wrong AAAA record stops the install.
3. Save it. If your domain is on Cloudflare, you can turn on its proxy (the orange cloud)
   now or later: see [Cloudflare's proxy](cloudflare.md). Any other proxy fails the
   installer's check, so use a plain **DNS only** record.

A new record can take from a minute to an hour or more to reach the server, and a "no such
name" answer your provider got earlier can be remembered for as long as that record's TTL.
You don't have to wait: the installer in step 4 checks the name first and changes nothing
if it isn't ready, and you can run it again later.

## 3. Log in to the server

You give the server commands through SSH, a text-only remote login. On Windows 10 and
later, macOS and Linux it is built in: open **Terminal** (or **PowerShell** on Windows)
and type, with your server's address:

```sh
ssh root@203.0.113.10
```

The first time, it asks whether you trust the server: type `yes`. Then enter the password
from your provider, or let your SSH key sign you in. Some providers create a different
user name than `root` (for example `ubuntu`); use the one your provider shows. If it isn't
`root`, type `sudo -i` once after logging in. The install folder, `/opt/plaingym`, can only
be opened by the root user, so the guides' `cd /opt/plaingym` step needs it.

When you are logged in, what you type runs on the server. To paste into the terminal, use
right-click or **Ctrl+Shift+V** (**Cmd+V** on a Mac). Nothing happens until you press
Enter.

## 4. Run the installer

Open the [releases page](https://github.com/plaingym/plaingym/releases) and note the
newest version, for example `v1.2.3`. On the server, paste this command with that version in
the address (it appears twice) and your own name and email:

```sh
curl -fsSL https://github.com/plaingym/plaingym/releases/download/vX.Y.Z/bootstrap.sh \
  | sudo sh -s -- --hostname gym.example.org --email owner@example.org
```

The `\` at the end of the first line continues the command on the next line; you can paste
both lines at once. The installer checks that the release is genuine (it verifies the
project's signature), checks that your name points at this server, installs Docker and
the firewall, starts the gym and waits for the certificate. This takes a few minutes. It
also turns on the nightly update timer, which installs fixes by itself
([what happens each night](updating.md)).

It ends by printing a line like this:

```text
https://gym.example.org/setup#token=…
```

**Copy that whole link somewhere safe.** It is private: whoever has it can create the
owner account.

If the installer stops with an error, it says what to check. Most checks run before it
changes anything and say "Nothing was changed". A few run after the gym has started (the
`/healthz` check and the check that the name reaches this server): by then the server is
installed, so don't wipe it. In every case, fix the cause and run the same command again;
running it again is safe. This one-command install is what the installer's messages call
"Route 1". The common causes are in [If something goes wrong](#if-something-goes-wrong)
below.

## 5. Open the setup link

Paste the link into a browser. The [setup wizard](self-hosting.md#setup-wizard) takes you
through the owner account, the gym's details, email, payments and backups.

**When the wizard shows the backup private key, download it and keep it somewhere off
this server** (a password manager is a good place). It is shown once. Without it, nobody
can open your backups, and you can't [restore the gym](restoring.md) after losing the
server.

If you lose the link before finishing, print it again on the server:

```sh
cd /opt/plaingym
sudo docker compose exec -T app gym-app setup-link
```

Also keep a copy of the file `/opt/plaingym/.env` off the server. It holds the gym's
encryption key and other secrets. To read it, run `sudo cat /opt/plaingym/.env` and copy
the output into your password manager.

## 6. Check that it works

* `https://gym.example.org/healthz` shows a short reply in the browser.
* On the server, `cd /opt/plaingym` and `sudo docker compose ps` list `caddy`, `app` and
  `postgres` as running.
* After setup, the admin's **System health** page shows the running version, the last
  backup and any failure.

Next: [import your members](importing.md), then [turn on billing and member emails](going-live.md).
They stay off until you do.

## If something goes wrong

| What you see | What to do |
| :--- | :--- |
| The installer says the name doesn't resolve, or points somewhere else | Check the A record in your DNS settings (the right name, the right address). Wait for it to spread, then run the same command again. If the server has no working IPv6, delete the AAAA record. The detail is in [DNS check](install-reference.md#the-dns-check). |
| The installer says it couldn't confirm the server's address | The server couldn't look up its own public address: see [the DNS check](install-reference.md#the-dns-check). |
| The certificate isn't issued | Check the firewall (ports 80 and 443) and the DNS record, then on the server run `cd /opt/plaingym` and `sudo docker compose logs caddy`. Don't delete the database volume to retry. |
| The installer finished but printed no setup link, saying the name answered with an HTTP error | A Cloudflare security setting may be challenging the visitor: see [Cloudflare's proxy](cloudflare.md#if-something-is-wrong). The server is installed; re-run the same command after fixing it. |
| The installer says the name answers, but not from this server | The DNS record points at another server. Fix the A (and AAAA) record so it points at this server, wait for it to spread, then re-run the same command. The server is installed. |
| The wizard's test email times out | Many providers (DigitalOcean among them) block outgoing email on ports 25, 465 and 587. Use the alternative port your email service offers (for example 2525), or ask your provider to unblock it. |
| The wizard says the backup storage address is wrong | Give the storage service's address without the bucket name (for example `https://ACCOUNT.r2.cloudflarestorage.com`); the bucket goes in its own field. |

## Other ways to install

The command above is the supported route. Two others finish in the same place: a
cloud-init file you give the provider when you create the server, and Docker Compose by
hand on a server you already manage. They, and how to read the installer script before
running it, are on the [install reference](install-reference.md).
