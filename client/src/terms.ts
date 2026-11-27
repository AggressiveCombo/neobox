// Terms of use: plain data, rendered by ui/screens/terms.ts. Keep the moderation text in step with
// crates/server (chat filters, reports, auto-mute) and the admin actions in crates/server/src/admin.rs.

import { OPERATOR_NAME, PRIVACY_CONTACT, type LegalSection } from "./privacy";

export const TERMS_UPDATED = "2026-11-27";

export const TERMS_SECTIONS: LegalSection[] = [
  {
    heading: "Who runs neobox",
    paragraphs: [
      `neobox is run by ${OPERATOR_NAME}, a private individual. The contact address is ${PRIVACY_CONTACT}. That address is also the single point of contact for authorities and users under the Digital Services Act (DSA). Please write in English.`,
    ],
  },
  {
    heading: "Accounts",
    paragraphs: [
      "You can play as a guest. To keep your level, friends and maps, create an account. By creating an account you agree to these Terms.",
      "You are responsible for what happens on your account, and you must keep your password secret. You may not sign in to someone else's account, or choose a name that impersonates another player.",
    ],
  },
  {
    heading: "Rules for using neobox",
    paragraphs: [
      "You must not publish illegal content; harass, threaten or spread hate; spam; cheat or exploit bugs; or publish maps, names or descriptions with illegal, sexual or hateful content.",
    ],
  },
  {
    heading: "Moderation",
    paragraphs: [
      "Filters on the server refuse the same chat message sent three times within 30 seconds. Chat words are not filtered on the server; players can turn on a swear filter for their own screen in Settings. Players can report others. When three different players report the same player in one room within 10 minutes, that player is muted in that room.",
      "Room hosts can mute, kick and ban players from their room.",
      "The operator reviews reports and can reject or remove maps and clips, rename accounts, delete accounts, suspend accounts for a set time or permanently, and ban IP addresses for a set time.",
    ],
  },
  {
    heading: "Reasons for decisions",
    paragraphs: [
      'When we remove a map or act against an account, we tell you why. A rejected map shows its author the reason as "Removed: <reason>". A suspended account sees the end date and the reason when it tries to sign in or join a room.',
    ],
  },
  {
    heading: "Appeals",
    paragraphs: [
      `To appeal a decision, write to ${PRIVACY_CONTACT} with your account name and the decision you are appealing. We reply without undue delay.`,
    ],
  },
  {
    heading: "Reporting illegal content",
    paragraphs: [
      `Report illegal content with the in-game report (category "Illegal content") or by email to ${PRIVACY_CONTACT}. The operator sees illegal-content reports first.`,
      "In an email, say where the content is (room code, map name or link, player name), why you believe it is illegal, and your name and email address, and confirm that your report is accurate and made in good faith. If you give an email address, you get a confirmation and a note of the decision.",
      "Where content suggests a threat to someone's life or safety, the operator informs the police.",
    ],
  },
  {
    heading: "Your content",
    paragraphs: [
      "Maps, names, clips and chat that you publish remain yours. You give the operator a non-exclusive, free licence to store, copy and show them within neobox, and to let other players play and view them there. Other players can see what you publish.",
      "Publish only what you made or have the right to share.",
    ],
  },
  {
    heading: "Copyright",
    paragraphs: [
      `If something on neobox infringes your copyright, write to ${PRIVACY_CONTACT} with the work, where it appears on neobox, and how to reach you. The operator removes infringing content once it is confirmed.`,
    ],
  },
  {
    heading: "Availability",
    paragraphs: [
      "neobox is free and provided as it is. It can change or stop. To the extent the law allows, the operator gives no warranty and is not liable for losses from using neobox, except for damage caused intentionally or by gross negligence.",
    ],
  },
  {
    heading: "Ending your use",
    paragraphs: [
      "You can stop playing and delete your account at any time. The operator can suspend or end accounts that break these Terms.",
    ],
  },
  {
    heading: "Open source",
    paragraphs: [
      "neobox's code is free software under the GNU Affero General Public License v3. The About screen links the source and the licences of the music, sounds and fonts.",
    ],
  },
  {
    heading: "Changes",
    paragraphs: ["We may update these Terms. The date at the top shows the last change."],
  },
];
