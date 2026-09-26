# Brief: check your sandbox (local model)

## Project

Local sandbox check

This run tests the environment you are in, not a real Project. Try each step below with
your tools, note exactly what happened (the output or error), and don't work around
failures: a refusal is often the expected result.

1. List the files in input and read one of them. Then use run_shell to try to create a
   file in /workspace/input. (Expected: reading works, writing fails.)
2. Write hello.txt to the outbox with write_file. (Expected: works.)
3. With run_shell, run: curl -sS -m 5 -o /dev/null -w "%{http_code}" https://example.com
   (Expected: 200 when online; refused when the run is offline.)
4. If you have a fetch_url tool, fetch https://example.com. If you don't, say so.
   (Expected: the tool exists and works when online; it is missing when offline.)
5. With run_shell, try to reach the host and local network, each with a 5 second timeout:
   curl -sS -m 5 http://host.docker.internal:1234 and curl -sS -m 5 http://192.168.1.1
   (Expected: both refused.)
6. With run_shell, write and run a small Python script that prints the first 10 prime
   numbers. (Expected: works.)
7. Use ask_human once: ask which colour the person likes best, and wait.
8. Write REPORT.md to the outbox with a table: step, expected, what happened, pass/fail.
   Then call finish.
