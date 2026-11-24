// Scam stories: the recipe library and the nouns for the "Also in here" line. Plain data; edit wording here only.
// Each recipe is a real, documented scam. Matching rules live in stories.js; the spec is
// docs/superpowers/specs/2026-11-23-scam-stories-design.md (§2 recipe table, §4 writing rules, "Country").
// `yoursOnly: true` (card, IBAN and ID key pieces): filled only by the account holder's own row, never "unknown".
// `who: "family"` (the child piece only): filled by the account holder's or an unknown row ("my son"), never a
// third party's ("her daughter"); always shown as "in your file".

const YOUR_NAME = { label: "Your name", kinds: ["self_name"], who: "you", optional: true };
const HOME_ADDRESS = { label: "Home address", kinds: ["street_address", "gps"], who: "you" };
const DATE_OF_BIRTH = { label: "Date of birth", kinds: ["date_of_birth"], who: "you" };
const PHONE_OR_EMAIL = {
  label: "Your phone or email",
  kinds: ["phone", "account_phone", "email", "account_email"],
  who: "you",
};

export const RECIPES = [
  {
    id: "pasted-password",
    title: "Sign in with what you pasted",
    scam: "Account takeover with a leaked password",
    about: "you",
    impact: "Costly",
    pieces: [
      {
        label: "A password or access key",
        kinds: ["password_cue", "api_token", "aws_access_key", "private_key", "tokenized_url", "jwt"],
        who: "you",
        key: true,
      },
    ],
    howItGoes: "A password or access key pasted into a chat works for whoever reads it. Someone with your file "
      + "could sign in as you, read your messages and files, or run up charges on a paid account.",
    fix: [
      "Change that password, or cancel that key and make a new one.",
      "Turn on two-step sign-in, so a password alone is not enough to get in.",
    ],
    source: {
      name: "FBI Internet Crime Complaint Center: Account takeover fraud",
      url: "https://www.ic3.gov/CrimeInfo/AccountTakeover",
    },
  },
  {
    id: "card-online",
    title: "Use your card online",
    scam: "Online card fraud",
    about: "you",
    impact: "Costly",
    pieces: [
      { label: "Card number", kinds: ["payment_card"], who: "you", key: true, yoursOnly: true },
      HOME_ADDRESS,
      YOUR_NAME,
    ],
    howItGoes: "Many online shops take a card number, its expiry date and security code, and sometimes a billing "
      + "address. If those are in your file, someone could buy things on your card without ever holding it. You "
      + "might only notice when the statement arrives.",
    fix: [
      "Ask your bank for a new card number; the old one then stops working.",
      "Check your statements and tell your bank about any payment you don't recognise.",
    ],
    source: {
      name: "Europol: Fraud against payment systems",
      url: "https://www.europol.europa.eu/crime-areas/online-fraud-schemes/fraud-against-payment-systems",
    },
  },
  {
    id: "direct-debit",
    title: "Take money from your account by direct debit",
    scam: "Direct debit fraud",
    about: "you",
    impact: "Costly",
    pieces: [
      { label: "Bank account number (IBAN)", kinds: ["iban"], who: "you", key: true, yoursOnly: true },
      HOME_ADDRESS,
      YOUR_NAME,
    ],
    howItGoes: "In many countries, an account number and a name are enough to set up a direct debit: a payment a "
      + "company takes from your account. Someone could use yours to pay for things you never ordered.",
    fix: [
      "Check your statements for direct debits you don't recognise.",
      "If you find one, ask your bank to reverse it; most banks can for a debit you didn't agree to.",
    ],
    source: {
      name: "Report Fraud (UK police): Bank account fraud",
      url: "https://www.reportfraud.police.uk/bank-account-fraud/",
    },
  },
  {
    id: "open-accounts",
    title: "Open accounts in your name",
    scam: "Identity fraud",
    about: "you",
    impact: "Hard to undo",
    pieces: [
      { label: "Government ID number", kinds: ["national_id"], who: "you", key: true, yoursOnly: true },
      DATE_OF_BIRTH,
      HOME_ADDRESS,
      YOUR_NAME,
    ],
    howItGoes: "Lenders and phone companies check an ID number, date of birth and address when someone applies. "
      + "With yours, someone could take out a loan, a credit card or a phone contract in your name, and leave you "
      + "to sort out the unpaid debt.",
    fix: [
      "Delete your ID number and date of birth from the chatbot's memory.",
      "If your country has credit reports, check yours for loans or accounts you didn't open.",
    ],
    source: {
      name: "Europol: Tips and advice to prevent identity theft",
      url: "https://www.europol.europa.eu/operations-services-and-innovation/public-awareness-and-prevention-guides/tips-and-advice-to-prevent-identity-theft-happening-to-you",
    },
  },
  {
    id: "bank-call",
    title: "Call your bank, pretending to be you",
    scam: "Account takeover by phone",
    about: "you",
    impact: "Costly",
    pieces: [
      { label: "Date of birth", kinds: ["date_of_birth"], who: "you", key: true },
      { label: "Your phone or email", kinds: ["phone", "account_phone", "email", "account_email"], who: "you" },
      { label: "Home address", kinds: ["street_address", "gps"], who: "you" },
      { label: "Your name", kinds: ["self_name"], who: "you", optional: true },
    ],
    howItGoes: "Someone could phone your bank and say they're you. Banks check who's calling with questions like "
      + "your date of birth and address. With those answers from your file, they could ask for a new card or a "
      + "change of phone number.",
    fix: [
      "Delete your date of birth and address from the chatbot's memory.",
      "Ask your bank to add a telephone password or passphrase to your account.",
    ],
    source: {
      name: "Report Fraud (UK police): Identity fraud and identity theft",
      url: "https://www.reportfraud.police.uk/identity-fraud-and-identity-theft/",
    },
  },
  {
    id: "sim-swap",
    title: "Move your phone number to their SIM",
    scam: "SIM swap fraud",
    about: "you",
    impact: "Hard to undo",
    pieces: [
      { label: "Your phone number", kinds: ["phone", "account_phone"], who: "you", key: true },
      DATE_OF_BIRTH,
      HOME_ADDRESS,
      YOUR_NAME,
    ],
    howItGoes: "Someone could call your mobile provider, pass its checks with your date of birth and address, and "
      + "have your number moved to their SIM card. Your phone would lose signal, and the one-time codes your bank "
      + "and email send by text would go to them.",
    fix: [
      "Ask your mobile provider to add a PIN or extra checks before anyone can swap or move your number.",
      "Delete your phone number and date of birth from the chatbot's memory.",
    ],
    source: {
      name: "ENISA (EU Agency for Cybersecurity): Beware of the SIM swapping fraud",
      url: "https://www.enisa.europa.eu/news/enisa-news/beware-of-the-sim-swapping-fraud",
    },
  },
  {
    id: "immigration-call",
    title: 'A call "from immigration"',
    scam: "Fake immigration officer call",
    about: "you",
    impact: "Costly",
    pieces: [
      { label: "Your visa or immigration status", kinds: ["immigration"], who: "you", key: true },
      PHONE_OR_EMAIL,
      { label: "Your employer", kinds: ["employer"], who: "you" },
      YOUR_NAME,
    ],
    howItGoes: "Someone could call or email you claiming to be from immigration, saying there's a problem with your "
      + "visa or papers. Knowing your status and employer makes it sound real, and they would ask for a fee or your "
      + "personal details to fix it.",
    fix: [
      "If someone calls or writes to you about your visa, don't pay or share details; check with the immigration "
        + "authority through its official website.",
      "Delete your visa details and employer from the chatbot's memory.",
    ],
    source: {
      name: "US Federal Trade Commission: Scammers impersonate US immigration officers",
      url: "https://consumer.ftc.gov/consumer-alerts/2022/07/scammers-impersonate-us-immigration-officers",
    },
  },
  {
    id: "work-message",
    title: 'A message "from work" wanting money or logins',
    scam: "Fake boss message",
    about: "you",
    impact: "Costly",
    pieces: [
      { label: "Your employer", kinds: ["employer"], who: "you", key: true },
      { label: "Your email", kinds: ["email", "account_email"], who: "you" },
      { label: "Your online profile", kinds: ["profile_url"], who: "you" },
      YOUR_NAME,
      { label: "Your salary", kinds: ["compensation"], who: "you", optional: true },
    ],
    howItGoes: "Knowing where you work, someone could email you pretending to be your boss or a colleague. They "
      + "would ask you to pay an urgent invoice, buy gift cards or sign in through a link that steals your work "
      + "password.",
    fix: [
      "Check any request for money or passwords by calling the person on a number you already have.",
      "Delete your employer and work email from the chatbot's memory.",
    ],
    source: {
      name: "Europol: Take control of your digital life (CEO fraud)",
      url: "https://www.europol.europa.eu/operations-services-and-innovation/public-awareness-and-prevention-guides/take-control-of-your-digital-life",
    },
  },
  {
    id: "doorstep",
    title: "Knock on your door, sounding official",
    scam: "Doorstep fraud",
    about: "you",
    impact: "A hassle",
    pieces: [
      { label: "Home address", kinds: ["street_address", "gps"], who: "you", key: true },
      YOUR_NAME,
    ],
    howItGoes: "Knowing your address, someone could knock claiming to be an official, a meter reader, a courier or a "
      + "tradesperson. They would ask to come in, or ask for a payment or your bank card.",
    fix: [
      "Keep the door closed until you've checked: call their organisation on a number you look up yourself.",
      "Delete your home address from the chatbot's memory.",
    ],
    source: {
      name: "Police Scotland: Rogue traders and doorstep crime",
      url: "https://www.scotland.police.uk/advice/scams-and-frauds/doorstep-crime-and-bogus-callers/",
    },
  },
  {
    id: "fake-insurer",
    title: "A fake insurer or pharmacy",
    scam: "Fake health insurer or pharmacy",
    about: "you",
    impact: "Costly",
    pieces: [
      { label: "A health condition", kinds: ["health"], who: "you", key: true },
      PHONE_OR_EMAIL,
      YOUR_NAME,
    ],
    howItGoes: "Someone who knows about your health could contact you posing as your insurer or a pharmacy, "
      + "offering cheaper medicine or asking you to settle a bill. Knowing your condition makes it sound genuine, "
      + "and they would ask for a payment or card details.",
    fix: [
      "If your insurer or pharmacy gets in touch unexpectedly, call them back on the number from your policy or "
        + "their official website.",
      "Delete health details from the chatbot's memory.",
    ],
    source: {
      name: "FBI Internet Crime Complaint Center: Criminals posing as health insurers",
      url: "https://www.ic3.gov/PSA/2025/PSA250627",
    },
  },
  {
    id: "hi-mum",
    title: 'Your "child" texting from a new number',
    scam: '"Hi Mum" or "Hi Dad" text scam',
    about: "others",
    impact: "Costly",
    pieces: [
      { label: "That you have a child", kinds: ["children"], who: "family", key: true },
      { label: "Your phone number", kinds: ["phone", "account_phone"], who: "you" },
      YOUR_NAME,
    ],
    howItGoes: "Someone could message you from a new number, pretending to be your son or daughter who has lost "
      + "their phone. After a little chat, they would ask you to pay an urgent bill for them. Knowing you have a "
      + "child makes it easy to believe.",
    fix: [
      "Before paying anything, call your child on the number you already have.",
      "Agree a family code word to ask for whenever a message asks for money.",
    ],
    source: {
      name: 'Scamwatch (Australia): warning as "Hi Mum" scams spike',
      url: "https://www.scamwatch.gov.au/about-us/news-and-alerts/accc-warning-of-suspicious-messages-as-%E2%80%9Chi-mum%E2%80%9D-scams-spike",
    },
  },
  {
    id: "friends-message",
    title: 'Your friends get a message "from you"',
    scam: "Hijacked account messages",
    about: "others",
    impact: "Costly",
    pieces: [
      { label: "Other people's contact details", kinds: ["email", "phone", "handle"], who: "others", key: true },
      YOUR_NAME,
    ],
    howItGoes: "Your file holds contact details for people you know. Someone could message them pretending to be "
      + "you, from a new number or a taken-over account, and ask for an urgent loan or for a code sent to their "
      + "phone.",
    fix: [
      "Delete other people's numbers and emails from the chatbot's memory.",
      "Tell family and friends you'd never ask for money or a code by message alone.",
    ],
    source: {
      name: "Singapore Police Force: WhatsApp account takeover scams",
      url: "https://www.police.gov.sg/media-hub/news/2024/20240607_police_advisory_on_the_resurgence_of_whatsapp_account_takeover_scams",
    },
  },
];

// [singular, plural] for the "Also in here: 4 places and 2 organisations." line. Every kind in KIND_LABELS.
// Keyword-based sensitive kinds (health, immigration, religion, sexuality, children) say "mention": a bare keyword
// is not a confirmed detail.
export const KIND_NOUNS = {
  aws_access_key: ["cloud access key", "cloud access keys"],
  private_key: ["private key", "private keys"],
  api_token: ["access token", "access tokens"],
  jwt: ["login token", "login tokens"],
  password_cue: ["password", "passwords"],
  tokenized_url: ["private link", "private links"],
  payment_card: ["card number", "card numbers"],
  national_id: ["identity number", "identity numbers"],
  health: ["health mention", "health mentions"],
  religion: ["mention of religion", "mentions of religion"],
  sexual_orientation: ["mention of sexuality", "mentions of sexuality"],
  children: ["mention of children", "mentions of children"],
  immigration: ["immigration mention", "immigration mentions"],
  street_address: ["street address", "street addresses"],
  gps: ["map location", "map locations"],
  profile_url: ["profile link", "profile links"],
  os_username: ["computer username", "computer usernames"],
  employer: ["employer", "employers"],
  compensation: ["salary detail", "salary details"],
  date_of_birth: ["date of birth", "dates of birth"],
  iban: ["bank account number", "bank account numbers"],
  email: ["email address", "email addresses"],
  phone: ["phone number", "phone numbers"],
  handle: ["social media username", "social media usernames"],
  url: ["link", "links"],
  name: ["name", "names"],
  self_name: ["mention of your name", "mentions of your name"],
  child_name: ["child's name", "children's names"],
  place: ["place", "places"],
  org: ["organisation", "organisations"],
  age: ["age", "ages"],
  date: ["date", "dates"],
  account_email: ["account email", "account emails"],
  account_phone: ["account phone number", "account phone numbers"],
};
