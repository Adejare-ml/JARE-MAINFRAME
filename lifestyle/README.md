# lifestyle

Evidence-based life advice for the mainframe, tuned to its owner.

| Path | What | In git |
|---|---|---|
| `how-to-live-better/` | *How to Live Better* (高性价比人生指南) by eternity4719: 34 chapters, 700+ tips, each graded by evidence and linked to a paper or official source. Copied from [github.com/eternity4719/HowToLiveBetter](https://github.com/eternity4719/HowToLiveBetter) at commit `e2605d3` (2026-10-24): `book/`, `README.md`, `index.html`, licences. Text is CC BY 4.0, code MIT. The long articles in its `docs/` were left out. | yes |
| `how-to-live-better/ORIGINAL_SKILL_zh.md` | The book's own Claude skill (Chinese), kept for reference. | yes |
| `PROFILE.md` | The owner's lifestyle profile: routine, sleep, food, training, money habits, goals, past decisions. | **no**, local only |
| `LOG.md` | Dated notes of what the owner said about his life. | **no**, local only |

The skill that uses all of this is `.claude/skills/lifestyle/SKILL.md`.

To update the book: shallow-clone the upstream repo and copy `book/`, `README.md` and
`index.html` over these, then update the commit above.

Note: law, policy and benefit figures in the book are for mainland China. The skill
treats them as background only.
