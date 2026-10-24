---
name: lifestyle
description: Daniel's personal lifestyle guide for Jare Mainframe. It answers "should I / is it worth it / what first" questions about sleep, food, exercise, health, money, time, work and relationships, using the evidence-graded book How to Live Better (lifestyle/how-to-live-better) filtered through Daniel's own profile (lifestyle/PROFILE.md). Use it whenever Daniel asks a life or self-improvement question, when planning goals, meals, budgets or the daily brief in the mainframe, and UPDATE it whenever Daniel mentions something about his habits, routine, health, diet, money, goals or what he wants to improve, in any chat.
---

# Lifestyle

Two parts, kept apart on purpose:

- **The book** (`lifestyle/how-to-live-better/`) is the evidence. Fixed text, never edited here.
- **Daniel's profile** (`lifestyle/PROFILE.md`) is the tuning. It says who he is, what he does now, what he wants, and what he has said yes or no to. It grows every time he talks about his life.

An answer is always book evidence filtered through the profile. The profile never invents evidence, and the book never overrides what Daniel has said about himself.

## When to use it

1. **He asks a life question**: "is a 2-hour commute worth it", "should I sleep earlier", "what should I eat to lose weight", "is this purchase worth it".
2. **Mainframe work that touches his life**: goals (`src/pages/Goals.jsx`, `src/lib/planning.js`, `planPrompt.js`), meals (`Meals.jsx`, `mealPrompt.js`), budgets and categories (`Budget.jsx`, `categories.js`), the daily brief and week review (`DailyHQ.jsx`, `src/components/daily/`), health (`src/lib/health.js`), reminders. Read `PROFILE.md` first, so defaults, prompts and suggestions fit him and not a generic user.
3. **He mentions something about his life in passing**, in any chat (the editing chats too). Then run "Updating the profile" below. This is the part that makes the skill his.

## Answering a question

1. **Read `lifestyle/PROFILE.md`** to see his situation, constraints and past decisions.
2. **Pick 1 to 3 chapters.** The table in `lifestyle/how-to-live-better/README.md` lists every chapter with the question it answers. Chapter files are `book/NN-<title>.md` (Chinese file names). Chapter map in English:

   | # | Topic | # | Topic |
   |---|---|---|---|
   | 01 | Don't die early | 18 | Is raising kids worth it |
   | 02 | Don't die slowly (chronic risk) | 19 | Work, quitting, work injury* |
   | 03 | Don't waste energy | 20 | Newborns |
   | 04 | Don't waste time | 21 | Travel abroad and safety* |
   | 05 | Don't waste money | 22 | How to relax |
   | 06 | The "don't do" list | 23 | Which skills are worth learning |
   | 07 | Living with no money* | 24 | Seeing a doctor* |
   | 08 | Don't get dragged into trouble* | 25 | After someone dies* |
   | 09 | Legal red lines* | 26 | Building a website or platform* |
   | 10 | Is dating and marriage worth it | 27 | Pregnancy and birth |
   | 11 | Red lines for programmers / tech | 28 | Don't wreck your body for looks |
   | 12 | Starting a business* | 29 | After a major blow |
   | 13 | Emergencies | 30 | School-age kids |
   | 14 | Account and information security | 31 | Paths after 18* |
   | 15 | Renting and buying a home* | 32 | Studying abroad* |
   | 16 | Living with chronic illness | 33 | Living with disability |
   | 17 | Elderly family | 34 | Home medicine cabinet safety |

   \* = law, policy, benefit or price figures written for **mainland China**. Daniel lives in **Lagos, Nigeria**. Use these chapters only for the general idea, say plainly that the rule or amount is Chinese, and never present a Chinese law, benefit, hotline or price as applying to him. The health, sleep, exercise, food, time, energy and money-habit material is general and applies.

3. **Pull the entries with grep, don't read whole files** (some are 110 KB):

   ```bash
   grep -rn '^### ' lifestyle/how-to-live-better/book/ | grep -E 'keyword1|keyword2'
   sed -n '/^### 16\. /,/^### 17\. /p' "lifestyle/how-to-live-better/book/08-<file>.md"
   ```

   Search in Chinese (睡眠 sleep, 运动 exercise, 饮食 diet, 体重 weight, 通勤 commute, 屏幕 screen, 咖啡 coffee, 酒 alcohol, 吸烟 smoking, 存钱 saving, 理财 finance, 学习 learning, 放松 relax). Read each entry in full, especially the 备注 (notes) line: who it applies to, disputes and exceptions live there.

   Each entry has a machine tag: `<!-- 成本标签: 钱=少 时间=少 毅力=否 收益=中 口径=死亡率 -->`, meaning money / time / willpower cost, payoff size, and what is gained (lifespan / money / time / freedom). Evidence grade is A > B > C.

4. **Rank**: best value first, then evidence A > B > C, then fit to the profile. The exact value bands are in `index.html` (`grep -n 'COST_W = \|e\.ratio = ' lifestyle/how-to-live-better/index.html`). Never trade lifespan against money on one scale: list them separately.

5. **Apply the profile**: drop entries for groups he is not in, flag entries that clash with something he already said no to, and turn the rest into steps that fit his real day (his schedule, budget in naira, what food is available in Lagos).

6. **Write the answer in English**, plain words:
   - One-line verdict and the first step.
   - Do these (3 to 7): action, what it costs, what it gives back, evidence grade, source as "chapter 8, entry 17 (title)".
   - Don't bother with: what the book says isn't worth it.
   - Not in the book: say so, and mark any common-sense advice as yours, not the book's.
   - Copy numbers exactly from the entry. Never invent numbers, DOIs or studies.

Hard rules kept from the book's own skill (`ORIGINAL_SKILL_zh.md`): emergencies first (in Nigeria, the Lagos emergency lines 112 / 767, not China's 120); for thoughts of suicide, give a crisis line before anything else and no pep talk; not a doctor, lawyer or financial adviser, and no personal investment advice.

## Updating the profile

When Daniel says something about his life (habits, sleep, food, training, health, money habits, work hours, goals, what he likes or hates, a decision he made):

1. Add a dated line to `lifestyle/LOG.md`: date, what he said (his words, short), where (which chat or project).
2. If it changes a fact or a preference, update the right section of `lifestyle/PROFILE.md`, and replace old facts instead of stacking contradictions. Put the date on the change.
3. If it should change the mainframe (a new goal, a meal rule, a budget category, a reminder), list it under **Mainframe ideas** in `PROFILE.md`. Build it only when he asks.
4. Tell him in one line what you saved ("Saved to lifestyle: you train at 6 am on weekdays").

Save only what he said or clearly confirmed. Don't record guesses.

**Privacy**: the repo is public. `PROFILE.md` and `LOG.md` are git-ignored and live only on Daniel's laptop (`C:\Users\adelu\Documents\JARE-MAINFRAME\lifestyle\`). Never commit them, never un-ignore them, and never copy their contents into code, commit messages, PRs, issues, prompts in `src/` or anything else that gets pushed. If a mainframe feature needs his preferences, store them in his Supabase data, not in the repo.
