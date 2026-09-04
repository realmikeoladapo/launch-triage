# Launch Triage field test

Launch Triage is looking for developers and product teams willing to run the
scanner on a real web or mobile repository and report where its evidence was
useful, noisy, or incomplete.

The goal is not to collect source code. It is to improve the scanner from
verified, privacy-preserving feedback.

## Run the scan

From the repository you want to inspect:

```bash
npx --yes launch-triage@1.2.2 . --json
```

For a CI-style threshold without failing on lower-severity findings:

```bash
npx --yes launch-triage@1.2.2 . --json --fail-on critical
```

Launch Triage runs locally, does not upload source, and does not execute the
application it inspects. Open every flagged file and confirm the evidence before
making a launch decision.

## What to report

Please share only sanitized observations:

- stack and project type, such as Next.js + Supabase or Expo;
- supported files scanned;
- rule IDs that were confirmed as real findings;
- rule IDs that were false positives and why;
- an important production-readiness problem the scanner missed;
- whether the report changed a launch, handover, or remediation decision;
- approximate review time after the scan completed.

Do **not** post source code from a private repository, credentials, customer
information, absolute workstation paths, or an unsanitized generated report.
A minimal synthetic example is preferred when code is necessary to explain a
false positive or false negative.

## Submit feedback

Use the **Field-test report** issue form. The form asks whether feedback may be
quoted anonymously. No project name or repository URL is required.

A useful report may be as small as:

> Next.js + Supabase, 184 files. AUTH-1 and DATA-1 were confirmed. OPS-3 was a
> false positive because rate limiting is enforced at the gateway. The scanner
> missed a payment redirect trusted without server-side verification. Human
> review took 18 minutes.

## How feedback becomes code

A confirmed false positive should become a safe control in the calibration
suite. A confirmed false negative should become a rule proposal with both an
unsafe fixture and a similar safe fixture. Feature requests such as SARIF,
configuration, and baselines are prioritized only when real adoption shows the
need.

## Evidence boundary

Field-test participation does not turn Launch Triage into a penetration test,
security certification, legal review, or guarantee of launch readiness. It
remains static evidence for a human reviewer.
