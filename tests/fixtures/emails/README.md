# Email fixtures

These are **synthetic placeholders**, written to match the field layouts the
parsers in `src/lib/parsers/` already encode. They lock in current parser
behaviour so a refactor can't change it silently.

They are not a substitute for the real thing. Replacing each one with a genuine
bank alert — **names, account numbers and balances redacted** — is the single
highest-value follow-up in this repo: the Opay direction bug survived months of
live use precisely because no real email was ever asserted against.

To add one: open the alert in Gmail, "Show original", copy the text/plain part,
redact, and save it here. Then add a case to `tests/parsers.test.js` with the
values you can see are correct by eye.

Still missing: Zenith, Polaris and PiggyVest. Those wallets have never had a
single email asserted against them.
