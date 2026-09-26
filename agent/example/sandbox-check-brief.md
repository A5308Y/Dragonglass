# Brief: check your sandbox

## Project

Sandbox check

This run tests the environment you are in, not a real Project. Try each step below,
note exactly what happened (command, output, error), and don't work around failures:
a refusal is often the expected result.

1. List /workspace/input and read a file there. Then try to create a file in
   /workspace/input and to change an existing one. (Expected: reading works, writing fails.)
2. Create /workspace/outbox/hello.txt. (Expected: works.)
3. Print whether the environment variable ANTHROPIC_API_KEY looks like a real key.
   Don't print the value itself. (Expected: it is only a placeholder.)
4. Fetch https://example.com with curl, and with the WebFetch tool. (Expected: both work.)
5. Try to reach your host and local network with curl, each with a 5 second timeout:
   http://host.docker.internal, http://192.168.1.1, http://169.254.169.254,
   https://example.com:8443. (Expected: all refused or unreachable.)
6. Write and run a small Python script that prints the first 10 prime numbers.
   (Expected: works.)
7. Use the ask_human tool once: ask which colour the person likes best, and wait.
8. Write /workspace/outbox/REPORT.md with a table: step, expected, what happened, pass/fail.
