Act as tech lead on this project. This plan is approved; do not ask me again,
execute it. Every task is read-only: nobody changes a file.

1. Map the API: list every route in `api/src/server.js` and what each returns.
2. Map the web client: list every call the web code makes to the API.
3. Audit `api/` for input-validation gaps. Needs task 1.
4. Audit `web/` for error-handling gaps. Needs task 2.
5. Check that every call from task 2 has a matching route from task 1, and
   name any mismatch. Needs tasks 1 and 2.
6. One merged report with the findings of tasks 3, 4 and 5, most severe first.
   Needs tasks 3, 4 and 5.

Delegate tasks 1 to 5; write the report yourself.
