# Moderation runbook

How the operator handles reports, illegal content and appeals. The player-facing rules are the
Terms screen (`client/src/terms.ts`); what is stored and for how long is the Privacy screen
(`client/src/privacy.ts`). Keep all three in step.

## What happens automatically

| Where | Rule | Code |
|---|---|---|
| Chat | Words are not filtered on the server. The swear filter is per player and off by default: a player who turns it on in Settings sees rude words masked on their own screen only | `client/src/profanity.ts`, `client/src/prefs.ts` |
| Chat | The same message 3 times in 30 s is refused; 3 messages burst, then 1 per 3 s | `room.rs` |
| Room | 3 different players (distinct IP and account) reporting the same player within 10 minutes mute that player in the room | `room.rs` |
| Public library maps | Wait for approval before they are listed | `crates/store/src/library.rs` |

## Daily routine (admin page, `/admin`)

1. **Reports**, sorted with "Illegal content" first. Each report carries the room's last chat lines
   and both players' names, accounts and IP addresses.
2. **Pending maps**: approve, or reject with a reason. The author sees "Removed: <reason>".
3. **Feedback**.

## Actions and when to use them

| Problem | Action |
|---|---|
| One offensive chat line | Mute, kick or ban the player by the host; suspend the account by the admin |
| Offensive name | Rename the account |
| Repeated harassment, hate or cheating | Suspend the account (days, with a reason); permanent for repeat offenders |
| Ban evasion with new guest names | IP ban for a set time (IPs are shared by schools and mobile networks, so keep it short) |
| Illegal content | Remove it at once (reject map, delete clip), suspend the account, then see below |

Every removal or suspension needs a reason: it is shown to the player (DSA Art. 17 statement of
reasons). Write it so the player understands which rule they broke.

## Illegal content

- **Threat to life or safety** (threats of violence, suicide risk, a child in danger): inform the
  police without delay, as the DSA requires (Art. 18). Give the room code, time (UTC), names and
  what was said.
- **Child sexual abuse material or links to it**: never open, download or forward it. Remove it,
  suspend the account and report it to the police and to a national hotline (list at
  https://www.inhope.org).
- **Everything else** (copyright, defamation, other illegal content): remove it once you have
  confirmed the notice is credible, and reply to the person who reported it if they gave an email.
- **Keep evidence**: a report keeps the chat lines and IP addresses for 180 days (IPs 30 days). If
  the police ask for data, give only what they ask for, and note the request.

## Appeals and notices by email

Appeals, illegal-content notices, copyright notices and data-protection requests arrive at
neobox@aggressivecombo.com.
- **Acknowledgement**: reply to each one.
- **Appeals**: decide within a reasonable time; undo the action if it was wrong.
- **Data-protection requests (GDPR)**: answer within one month.
