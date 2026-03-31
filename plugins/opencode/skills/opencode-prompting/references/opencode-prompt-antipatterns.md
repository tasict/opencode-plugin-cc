# OpenCode Prompt Anti-patterns

## Vague Requests
- BAD: "Fix the tests"
- GOOD: "Fix the failing test in tests/api.test.ts -- the POST /users endpoint returns 500 instead of 201 when email contains unicode characters"

## Kitchen Sink Prompts
- BAD: "Review the entire codebase and fix all issues, add tests, update docs, and refactor"
- GOOD: "Add input validation to the createUser handler in src/handlers/user.ts for the email and name fields"

## Missing Context
- BAD: "It doesn't work"
- GOOD: "Running `npm test` produces TypeError: Cannot read property 'id' of undefined at src/models/user.ts:42"

## Assuming Knowledge
- BAD: "Use our standard pattern"
- GOOD: "Follow the repository pattern used in src/repos/product-repo.ts with dependency injection via constructor"

## Contradictory Instructions
- BAD: "Make minimal changes but also refactor the entire module"
- GOOD: "Fix the null pointer in processOrder() with minimal changes -- do not refactor surrounding code"
