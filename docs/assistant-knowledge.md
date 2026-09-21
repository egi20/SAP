# What SAP Hub is, and where everything lives

SAP Hub is a marketplace and toolset for the SAP consulting ecosystem: a job board, a
consultant and company directory, a contributed day-rate index, an SAP Activate scope
estimator, messaging and a community. It is independent and is not affiliated with SAP SE.

Everything below is the whole truth about this site. Paths are site-relative and every one
of them is a real page — a test opens all of them.

## Finding work and finding people

- `/jobs` — the job board. Filter by SAP module, SAP Activate phase, role, seniority,
  engagement type, work mode and country. Modules filter as ANY-of: an advert naming four
  modules appears under all four, because a programme that touches four is what somebody
  browsing for MM or EWM wants to see.
- `/jobs/new` — post a role. Companies only. A draft stays private until it is published.
- `/consultants` — the talent directory. Filters include modules actually DELIVERED,
  which come from consultants' engagement history rather than from a skills checklist.
- `/companies` — companies with a profile.
- `/applications` — your applications if you are a consultant, and your pipeline if you
  posted the role.

## Your profile

- `/profile/consultant` — the consultant profile: skills, SAP certifications, work
  history, delivered engagements, day rate and availability. A profile must reach 60%
  completeness before it can be listed publicly.
- `/profile/company` — the company profile and logo.
- `/profile/settings` — account settings, password, and adding a consultant, company or
  recruiter role to an existing account.
- `/dashboard` — your own starting point once signed in.

Certifications are chosen from a catalogue and stored by code, never as free text, because
SAP re-versions its exams every year and a typed-in year makes a credential look stale
within twelve months.

## The day-rate index

- `/rates` — contributed day rates as percentiles, by role, seniority, engagement type and
  country, with a twelve-month trend.
- `/rates/submit` — contribute your own figure. Consultants only.

No bucket is ever published until at least three different PEOPLE have contributed to it.
One person submitting five times is still a sample of one, and a period below the floor is
shown as a gap — never as a zero and never interpolated. Figures are always aggregates:
nobody's individual rate is shown to anybody.

## The scope estimator and quotes

- `/quotes/new` — build an SAP implementation estimate: pick the modules in scope, the
  transition approach (greenfield, brownfield or selective), the clean-core level, users,
  company codes, countries and integrations.
- `/quotes` — estimates you have saved.

The estimate distributes effort across all six SAP Activate phases — discover, prepare,
explore, realize, deploy and run. Phase days and resource days each sum exactly to the
total, and every cost is days times a day rate, so the budget reconciles line by line.
Cross-module integration is charged once per pair of modules, not from both sides.

A saved quote can be downloaded as a statement of work (.docx), a work breakdown with a
Gantt (.xlsx), a summary deck (.pptx), or all three zipped together. Documents are
generated when you ask for them and never stored.

A quote keeps the prices it was built under. If the effort catalogue changes afterwards the
quote is flagged as priced under an older catalogue — it is never quietly re-priced,
because the stored breakdown is what was said to a client on a date.

## Messaging and the community

- `/messages` — your conversations. Every thread is anchored to a subject: an application,
  or an enquiry about a specific role. There is no open direct-message inbox.
- `/community` — questions, discussions, articles and wins, with votes and accepted
  answers. Posting, replying and having an answer accepted earn points and levels.
- `/community/new` — write a post.

## Paying for things

- `/payments` — the two things that cost money: a featured job placement, and a deposit
  against an accepted quote. Posting a job, applying, the rate index, the estimator,
  messaging and the community are free.
- `/payments/history` — your payments and invoices.

Never quote a price from memory. Send people to `/payments`, which has the real figures.

## Accounts

- `/auth/register` — free to join, as a consultant, a company or a recruiter. One account
  can hold more than one role.
- `/auth/login` — sign in.

## Legal and contact

- `/legal/terms`, `/legal/privacy` — the policies.
- `/contact` — reach a person.
