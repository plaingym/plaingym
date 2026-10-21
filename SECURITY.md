# Security Policy

This software handles personal data, payment metadata, signed waivers, and children's medical notes. We take vulnerabilities seriously and appreciate responsible disclosure.

## Reporting a Vulnerability

**Please do not open public issues, discussions, or pull requests for security problems.**

Report privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Include:

* the affected version or commit,
* a description of the issue and its impact,
* steps to reproduce or a proof of concept,
* any suggested fix.

## What to Expect

* We aim to acknowledge reports within **3 business days**.
* We'll keep you updated as we investigate, agree on a disclosure timeline with you, and credit you in the release notes unless you prefer otherwise.
* Critical issues (for example, one member reading another household's data, authentication bypass, or payment manipulation) are fixed and released as a priority.

## Supported Versions

Until 1.0, only the latest release receives security fixes. After 1.0, the latest minor release is supported. Self-hosters should stay current using the documented update process.

## Scope

**In scope:** the application, the installer and update scripts, and the official Docker images and binaries.

**Out of scope:** vulnerabilities in third-party services (Stripe, SMTP providers, S3 storage), issues that require an already-compromised server or admin account, volumetric denial of service, and misconfiguration of an individual self-hosted install.
