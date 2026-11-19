# The reviewer's bot identity

Every note the reviewer posts belongs to the GitLab user that owns
`REVIEW_GITLAB_TOKEN`, and the review job carries that user's access for the
whole run, including the part where a model reads merge request content from
strangers. This page covers how to create that user on a self-managed
instance, which role it gets where, how to issue, store and rotate its token,
what changes when you switch accounts, and what degrades when the token
belongs to a person.

Wiring, project layout and every other variable:
[ci-reviewer-setup.md](ci-reviewer-setup.md).

GitLab behaviour on this page (API responses, defaults, error messages) was
measured on GitLab CE 18.11. Recheck it after a GitLab upgrade.

## 1. What the reviewer needs from the identity

| Requirement | Why |
|---|---|
| A non-administrator account | `resolve` refuses an admin token: the review job holds it while an agent reads untrusted text |
| Reporter on the config project, never Developer or above | `resolve` refuses Developer or above there; whoever can push to the config branch can rewrite the pipeline file that receives every key. Reporter is also the minimum `resolve` needs to read the project and its branch protection |
| Reporter on the reviewer project, below Maintainer | a Maintainer there can read every scoped key through the API; `resolve` refuses Maintainer or above |
| Developer on every source project | posts the summary note and the inline threads, sets and clears the eyes marker, removes the `maestro-review::deep` label, clones the source for profile and deep reviews |
| A personal access token with scope `api` | `read_api` cannot post; `CI_JOB_TOKEN` cannot post either |
| A username equal to `REVIEW_BOT_USERNAME` | see the two identity keys below |

Role levels, for reference: Guest 10, Reporter 20, Developer 30, Maintainer
40, Owner 50.

### The two identity keys

The reviewer recognizes its own work by two different keys, and they fail
differently:

| Key | Where it comes from | What uses it |
|---|---|---|
| **User id** | `GET /user` with `REVIEW_GITLAB_TOKEN`, at run time | the "already reviewed" gate (the latest summary note with review metadata), the coexistence check, the "another review is running" check (eyes award), which `/maestro` commands were already answered |
| **Username** | `REVIEW_BOT_USERNAME` (default `maestro-bot`), a plain case sensitive string | its own threads (the dedupe the model is told to apply, and the open finding keys for engine findings), which finding codes it raised (dismiss counting), removing its own award markers (eyes, check mark, warning) |

In both cases a note only counts as the reviewer's when it also carries a
reviewer marker (or, for notes written before markers existed, starts with a
severity label). Anything else written with the same account is treated as a
person's note.

`resolve` compares `REVIEW_BOT_USERNAME`, or its default, with the username
`GET /user` returns for the token, case included, and fails the pipeline on a
mismatch before any review runs. Without that check a wrong name would only
show up later as a stuck eyes award and findings reopened as new threads.

## 2. What a person's token costs

A common shortcut is to point the reviewer at a Maintainer's own token, set
`REVIEW_BOT_USERNAME` to that person's username, and add
`REVIEW_ACCEPT_PRIVILEGED_BOT=1` so `resolve` warns instead of refusing on the
role checks. The flag never accepts an administrator token.

The reviewer works on such an account. Because it tells its notes apart by
marker, the person's own notes still count as theirs: a `/maestro dismiss`
they write is counted, their other `/maestro` commands are answered, and an
answer in a finding thread stops the reviewer from restating the finding on
unchanged code. What it still costs:

1. **Reviewers cannot tell automation from a colleague.** Every finding is
   attributed to the person, which is exactly the case where a wrong finding
   is argued with instead of ignored.
2. **The job keeps a person's whole access** while a model reads attacker
   controlled content, which is the risk the two role checks exist for.
3. **Moving off it later has a one time cost** for every open merge request,
   see section 8. The longer the shortcut lives, the more history the switch
   leaves behind.

The escape hatch exists for the period before a dedicated account appears.
Treat it as a scheduled removal, not a configuration.

## 3. Which kind of account

The bot must be a member of the reviewer project, the config project and
every source project, usually in different top-level namespaces, with a
different role in each. That rules out every token whose bot user is tied to
one group or project.

| Option | Edition | Fits this reviewer | Verdict |
|---|---|---|---|
| Plain **user account** with an administrator issued token | CE and EE | Can be a member anywhere with any role; appears as a person in member lists | **Recommended on CE** |
| Instance **service account** | EE; on CE both `POST /service_accounts` and `POST /groups/:id/service_accounts` answer 404 | Can be invited anywhere, never signs in | Option on EE; not verified for this reviewer |
| **Group access token** | CE and EE | Its bot user cannot be added to any group or project outside its group (`project bots cannot be added to other groups / projects`), and inside the group it inherits the token's role on every project, which cannot be lowered per project | **Does not work**: it needs Developer for the source projects, so it is Developer on a config project in the same group, and `resolve` refuses that |
| **Project access token** | CE and EE | Its bot user belongs to that single project | Cannot be the one shared token |
| `CI_JOB_TOKEN` | All | Reads work, posting the note fails (`POST /notes` 401) | No |
| Deploy token | All | No API access | No |

The deciding factor is reach and per project roles, not tier. Check the
edition first: `GET /api/v4/metadata` answers `"enterprise": false` on CE.

## 4. Create a plain user account (CE and EE)

Requires instance administrator access.

### With the Admin area

1. **Admin > Overview > Users > New user**: name `Maestro Reviewer`,
   username `maestro-bot`, an address you control, projects limit 0, no
   access to create groups. The username is copied into
   `REVIEW_BOT_USERNAME` later, character for character.
2. Do not keep a password for it. The token is issued by an administrator
   (below), so nobody needs to sign in as the bot.

### With the API

```sh
curl --request POST --header "PRIVATE-TOKEN: $ADMIN_TOKEN" \
  --data-urlencode "name=Maestro Reviewer" --data "username=maestro-bot" \
  --data "email=maestro-bot@example.com" --data "force_random_password=true" \
  --data "skip_confirmation=true" --data "projects_limit=0" \
  --data "can_create_group=false" \
  "$GITLAB/api/v4/users"
```

The response carries `id`. Then issue the token as an administrator:

```sh
curl --request POST --header "PRIVATE-TOKEN: $ADMIN_TOKEN" \
  --data "name=reviewer" --data "scopes[]=api" \
  --data "expires_at=2027-06-30" \
  "$GITLAB/api/v4/users/$BOT_ID/personal_access_tokens"
```

The value is in the response's `token` field and is never shown again.
Always pass `expires_at`: without it GitLab sets one year from today.
Because an administrator issues the token, nobody signs in as the bot, so an
instance wide 2FA requirement does not get in the way. LDAP or SAML
synchronization can still disable or re-provision a local account; exclude
it if your instance runs one.

On EE an instance service account can replace the user (**Admin >
Settings > Service accounts**, or `POST /api/v4/service_accounts`), with the
token issued the same way. This reviewer has not been verified against one.

## 5. Role per project

| Project | Role | Level |
|---|---|---|
| Config project | Reporter | 20 |
| Reviewer project | Reporter | 20, never Maintainer |
| Each source project, or its group | Developer | 30 |

Two traps:

- **A role is the maximum over every membership, and an inherited role
  cannot be lowered.** A bot that is Developer on a group which contains the
  config project is Developer on the config project, and GitLab refuses to
  add it there as Reporter (`should be greater than or equal to Developer
  inherited membership`). Give the bot per project membership for the two
  control projects, and group membership only for source namespaces that do
  not contain them.
- **A shared group widens the same way.** `resolve` counts membership through
  shared groups too (`/projects/:id/members/all/:user_id`), so a group shared
  into the config project can lift the bot above Reporter. Check with the
  verification calls in section 7 rather than trusting the Members page.

## 6. Store the token

On the reviewer project, **Settings > CI/CD > Variables**:

| Variable | Value | Flags |
|---|---|---|
| `REVIEW_GITLAB_TOKEN` | the bot's token | protected, masked, expand off |
| `REVIEW_BOT_USERNAME` | the bot's username, exactly | protected |

The engine falls back to `maestro-bot` when `REVIEW_BOT_USERNAME` is unset, so
naming the account `maestro-bot` keeps the variable optional. Any other
username has to be set, and set exactly: the comparison is case sensitive.

A username does not need masking, since it is not a secret, and a short one
cannot be masked: GitLab rejects a masked value under eight characters
(`value is invalid`).

Then delete `REVIEW_ACCEPT_PRIVILEGED_BOT`. With a dedicated account the two
role checks pass on their own, and the flag only removes the guardrail.

Protected variables only reach pipelines on protected branches, so the
reviewer branch must be protected first, as in the setup page.

## 7. Verify

Run these with the bot's own token, and compare against the table in
section 5:

```sh
# username must equal REVIEW_BOT_USERNAME; is_admin must be absent or false
# (GitLab only includes is_admin in GET /user when the caller is an admin)
curl --header "PRIVATE-TOKEN: $BOT_TOKEN" "$GITLAB/api/v4/user"

# scopes and expiry of the token itself
curl --header "PRIVATE-TOKEN: $BOT_TOKEN" "$GITLAB/api/v4/personal_access_tokens/self"

# effective role per project: 20 on both control projects, 30 on sources
for p in "$REVIEWER_PROJECT" "$CONFIG_PROJECT" "$SOURCE_PROJECT"; do
  curl --header "PRIVATE-TOKEN: $BOT_TOKEN" \
    "$GITLAB/api/v4/projects/$p/members/all/$BOT_ID"
done
```

`$BOT_ID` is the `id` from the first call.

Then open a throwaway merge request in a source project **as a user with
Developer only**, and confirm one `Maestro Review` note whose author is the
bot, with `resolve` and the review job both green. A Maintainer's merge
request proves less: it can trigger branches a Developer cannot.

## 8. Migrating off a person's token

No downtime is needed: the reviewer reads one token, so the swap is the
variable update itself. It is not free, though. The reviewer's memory of a
merge request is the notes its account wrote there, and the new account
wrote none, so on every merge request that is open at the switch:

- The next pipeline runs a **full review**, even without `REVIEW_ON_PUSH`:
  the "already reviewed" gate finds no summary note by the new user id.
- Findings that already have a thread are **posted again as new threads**:
  the old threads belong to the old username, so they are not the
  reviewer's own any more.
- `/maestro` commands that were already answered are **answered again**, at
  most five per run, a past `/maestro rereview` included: their answers were
  written by the old user id.
- Dismiss counting starts over: codes raised by the old account no longer
  count as raised, so a muted code can come back until new dismissals add up.

So switch when few merge requests are open, and tell the team to expect one
noisy pass.

1. Create the account and its memberships (sections 4 and 5). Nothing changes
   yet.
2. Issue the token, then update `REVIEW_GITLAB_TOKEN` and
   `REVIEW_BOT_USERNAME` together, and delete `REVIEW_ACCEPT_PRIVILEGED_BOT`.
   Until both are updated, `resolve` refuses the pipeline with a username
   mismatch, so a half done swap stops reviews instead of degrading them.
3. Run the canary merge request from section 7.
4. Keep the old personal token valid for a week as rollback, then revoke it.
   Notes posted before the swap stay attributed to the person, and eyes
   awards the old account left behind are not cleared by the new one: remove
   them by hand if any are left.

## 9. Failure signatures

A token that can no longer read fails loudly and early. `resolve` reads the
config project and `GET /user` with `REVIEW_GITLAB_TOKEN` before any review
starts. A revoked token answers 401 there (`Token was revoked`), and an
expired one is refused the same way, so the reviewer pipeline fails with
`cannot read the config project ... (401)`.

A token that can read but not write fails quietly: the review runs, the job
reports completion, and no note appears. The log shows `posting review
comment failed` with the status, and the review body is written to the
failed report. Causes: scope `read_api` instead of `api`, or the bot is not
Developer on the source project.

## 10. When it goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| `REVIEW_GITLAB_TOKEN belongs to a GitLab administrator` | admin token | create a non-admin account, section 4 |
| `... is Developer or above on the config project ...; it must be Reporter there` | direct or inherited role on the config project | section 5, and check shared groups |
| `... is Maintainer or above on the reviewer project ...` | inherited from a group that owns the reviewer project | make the bot a direct Reporter member, remove the wider membership |
| `cannot read the config project ... (401)` | expired or revoked token | issue a new token, section 11 |
| `cannot read the config project ... (404)` | no membership on a private config project | add the bot as Reporter |
| Review completes but no note appears | token without `api`, or bot not Developer on the source project | section 9 |
| `REVIEW_BOT_USERNAME is "..." but REVIEW_GITLAB_TOKEN belongs to "..."` | the variable, or the `maestro-bot` default when it is unset, is not the token owner's username | set `REVIEW_BOT_USERNAME` to the quoted owner, exactly as written |
| `another review is running, skipping` with no review running | a stale eyes award: a cancelled pipeline never ran its cleanup, or one was left by a wrong username before `resolve` checked it | delete the bot's eyes award from the merge request |
| Duplicate threads and repeated command answers on every open MR, once | the bot account was switched | expected, section 8 |

## 11. Rotation

- Record the expiry next to the project, not in someone's calendar only. An
  expired token stops every review at `resolve`.
- Prefer issuing a new token over rotating in place. Issue it (section 4),
  update `REVIEW_GITLAB_TOKEN`, run the canary, then revoke the old one: no
  pipeline ever runs without a valid token.
- If you do rotate in place (`POST /personal_access_tokens/:id/rotate`), the
  old value stops working at once (401 `Token was revoked`), so pipelines
  fail until the variable is updated. **Pass `expires_at`**: without it the
  rotated token expires in seven days.
- Prefer a 12 month expiry with a reminder. GitLab sets one year when no
  expiry is given, so a token without one does not exist on a default
  instance.
- Re-check section 7 after any group restructuring. Inherited roles are the
  usual way a well configured bot becomes a privileged one months later.
