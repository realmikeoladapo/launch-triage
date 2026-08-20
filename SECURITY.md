# Security policy

## Supported versions

Security fixes are provided for the latest `1.x` release. Users should upgrade
to the newest patch version before reporting a problem.

## Report a tool vulnerability privately

Use GitHub's **Report a vulnerability** flow in the Security tab when it is
available. If private vulnerability reporting is unavailable, email
[hello@mikeoladapo.com](mailto:hello@mikeoladapo.com) with the subject
`Launch Triage security report`.

Include the affected version, impact, a minimal reproduction, and any suggested
mitigation. Do not open a public issue until a fix or disclosure plan is agreed.
You should receive an acknowledgement within five business days.

Examples of private security reports include:

- a way for a scanned repository to execute code through Launch Triage;
- credential material leaking into reports despite redaction;
- unsafe file writes outside the requested output path;
- a supply-chain or package-publication compromise.

## Report scanner accuracy publicly, with synthetic data

False positives, false negatives, missing patterns, and severity disagreements
are normally accuracy bugs rather than vulnerabilities in the tool. Use the
appropriate issue form with a small synthetic repository or code sample.

Never paste a live credential, private client source, customer identifier, or
unsanitised report into a GitHub issue. Rotate a real credential at its provider
before doing anything else.
