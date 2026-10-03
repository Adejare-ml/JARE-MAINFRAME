## 2024-05-18 - Missing password complexity requirements
**Vulnerability:** Weak password requirements. The application only enforced an 8-character minimum without requiring mixed cases or numbers, making it susceptible to easily guessable passwords.
**Learning:** Auth endpoints must enforce standard complexity rules to protect user accounts, especially in applications that may handle sensitive financial data.
**Prevention:** Implement strict regex validation for at least one uppercase, lowercase, and numeric character in password reset/creation flows.
