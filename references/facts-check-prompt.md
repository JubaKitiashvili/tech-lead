# Re-checking the model facts

A read-only task for one agent with web access. Sonnet 5.5 is enough: the
work is reading pages and comparing sentences.

```
GOAL
Re-check each fact in the table below against the page it names, and report
which still hold. Change nothing: no file edits, no commits.

INPUT
The output of `node <plugin root>/scripts/facts-check.mjs list` (JSON: id,
fact, used_in, source, checked).

FOR EACH FACT
1. Fetch the source URL. If it fails or redirects, say so and try the
   site's search once; do not substitute another site.
2. Find the passage that supports or contradicts the fact. Quote it exactly.
3. Give one verdict:
   - confirmed: the page says the same thing;
   - changed: the page says something different (give the new value);
   - gone: the page no longer covers it;
   - unreachable: the page could not be read.
Do not fill a gap from memory. A number that is not on the page is "gone".

ALSO
Look once at https://code.claude.com/docs/en/changelog and at
https://www.anthropic.com/news for a model or Claude Code release newer than
the newest `checked` date. Name it if there is one; it may have changed
facts that this table does not list yet.

OUTPUT
A table: id | verdict | quote | what to change in the plugin (file and the
sentence), or "nothing". Then a list of new releases found. Then one line:
how many confirmed, changed, gone, unreachable.
```

After the report:

- For every confirmed row, set its `Checked` date in
  `references/model-facts.md`.
- For a changed or gone row, open a pull request that changes the rule or
  the reference text, with the quote in the description. A rule that changes
  behaviour is re-measured with the eval suite before it merges.
- A new release usually means reading its prompting guide and migration
  notes before trusting any row here.
