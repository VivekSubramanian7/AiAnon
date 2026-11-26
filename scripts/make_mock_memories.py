"""
Generate fake chatbot memories and exports for testing the TMI scanner.

Every person, address and account here is invented. Emails use example.com/.org/.net,
phone numbers come from ranges reserved for fiction (+1 xxx 555 01xx, +44 7700 900xxx,
+49 170 555 xxxx) and the IBANs are the standard published example IBANs.

    python scripts/make_mock_memories.py            # writes samples/mock-memories/
"""

import io
import json
import os
import random
import zipfile

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "samples", "mock-memories")


# ---------- plain-text memories ----------

CHATGPT_SAVED_MEMORIES = """\
Name is Dana Whitfield.
Works as a paediatric nurse at St Mary's Hospital in Leeds.
Lives in Headingley, Leeds with partner Chris Doyle and a cat called Biscuit.
Was born on 03.07.1989.
Is 36 years old.
Personal email is dana.whitfield@example.com.
Mobile number is +44 7700 900123.
Prefers British spelling.
Is training for the Great North Run in September.
Sister Jess Whitfield lives in Manchester and has twin boys.
Asked for help disputing a charge paid to IBAN GB82 WEST 1234 5698 7654 32.
Has asthma and uses a blue inhaler.
Posts running photos on Instagram as @dana_runs_leeds.
Is planning a trip to Lisbon in May and is learning Portuguese.
Manager Priya Shah is leaving Northern Care Trust next month.
Prefers short answers with bullet points.
"""

GEMINI_SAVED_INFO = """\
I'm vegetarian and allergic to peanuts.
My name is Kofi Mensah.
I live in Accra but I'm moving to London in September.
I work as a sound engineer at Blue Room Studios.
My email is kofi.mensah@example.com and my phone is +233 20 555 0187.
I'm 31 and my birthday is 22/01/1995.
My partner Ama Owusu is a midwife.
I support Arsenal and play five-a-side on Thursdays.
Explain things to me like I'm a smart beginner.
"""

BOT_ANSWER = """\
Here's what I remember about you:

- You're Sam Rivera, a high-school chemistry teacher in Denver, Colorado.
- You're 29, and your birthday is 08/04/1997. You asked me for cake ideas last year.
- You teach at Lincoln Park High School and coach the robotics team.
- Your partner is Jordan Lee, and you have a rescue greyhound called Comet.
- You're saving for a house and asked me to compare mortgage offers from First Summit Bank.
- Your school email is s.rivera@lincolnpark.example.edu and your personal one is samrivera@example.org.
- You once shared your number, +1 303 555 0119, when drafting a message to a contractor.
- You like hiking, sour candy and long explanations with examples.

Let me know if you want me to forget any of this.
"""

# A memory summary in the style of Claude's memory: written to the user, in paragraphs under topic headings.
CLAUDE_MEMORY_SUMMARY = """\
Here's what I remember about you, grouped by topic.

Work context
You work at Lindqvist Freight in Munich as a logistics planner, mostly in Excel and SQL. You moved there from Lyon in 2019, and your Niederlassungserlaubnis came through in March.

Personal context
Your name is Ines Moreau. You're married to Tobias, and your daughter is Margaux. You shared your mobile number, +49 170 555 0142, and your email, ines.moreau@example.net, while drafting a letter to your landlord.

Top of mind
You've asked about your own anxiety a few times, and about breathing exercises before big presentations. Last spring you were diagnosed with a deep vein thrombosis after a long flight.

Brief history
In October you asked about lazy-eye treatment for your then three-year-old. You prefer short answers, British spelling and worked examples.
"""

CLEAN_MEMORY = """\
Prefers concise answers.
Likes Python and TypeScript.
Enjoys hiking and science fiction novels.
Is learning to bake sourdough bread.
Wants explanations with a worked example.
Dislikes emojis in replies.
Uses metric units.
Prefers dark mode screenshots in tutorials.
"""


# ---------- ChatGPT data export ----------

def chatgpt_node(node_id, role, text=None, t=0, parts=None, content_type="text", **content):
    message = {
        "id": node_id,
        "author": {"role": role, "name": None, "metadata": {}},
        "create_time": 1767225600 + t,
        "content": {"content_type": content_type, **content},
        "status": "finished_successfully",
        "metadata": {},
    }
    if content_type in ("text", "multimodal_text"):
        message["content"]["parts"] = parts if parts is not None else [text]
    return {"id": node_id, "message": message, "parent": None, "children": []}


CUSTOM_INSTRUCTIONS = {
    "user_profile": "I'm Priya, a data analyst in Austin, Texas. I have a beagle called Pixel.",
    "user_instructions": "Be concise. Use US spelling.",
}


def chatgpt_conversation(title, turns):
    mapping = {"root": {"id": "root", "message": None, "parent": None, "children": []}}
    mapping["sys"] = chatgpt_node("sys", "system", "", t=0)
    mapping["ctx"] = chatgpt_node("ctx", "user", t=1, content_type="user_editable_context", **CUSTOM_INSTRUCTIONS)
    for i, (role, text) in enumerate(turns):
        node_id = f"m{i}"
        if isinstance(text, list):  # multimodal parts
            mapping[node_id] = chatgpt_node(node_id, role, t=10 + i, parts=text, content_type="multimodal_text")
        else:
            mapping[node_id] = chatgpt_node(node_id, role, text, t=10 + i)
    return {"title": title, "create_time": 1767225600, "update_time": 1767229200, "mapping": mapping,
            "conversation_id": title.lower().replace(" ", "-"), "default_model_slug": "gpt-5"}


CHATGPT_CONVERSATIONS = [
    chatgpt_conversation("Boiler email to landlord", [
        ("user", "Can you write a polite email to my landlord Tom Becker about the broken boiler? I'm Priya "
                 "Natarajan, flat 4B at 18 Elm Grove, Austin TX 78704. My phone is +1 512 555 0147."),
        ("assistant", "Of course, Priya! Here's a draft for Tom Becker:\n\nDear Tom, ..."),
        ("user", "Add that my rent is paid on the 1st and he can reach me at priya.n@example.org."),
        ("assistant", "Updated. I added your email priya.n@example.org at the end."),
    ]),
    chatgpt_conversation("KeyError in script", [
        ("user", "Why does this crash?\n```python\nuser_id = 5125550147\nprint(users[user_id])\n```\n"
                 "The error says KeyError."),
        ("assistant", "The key 5125550147 isn't in the dict. Try users.get(user_id)."),
        ("tool", "Ran code: KeyError: 5125550147"),
    ]),
    chatgpt_conversation("Birthday dinner", [
        ("user", "My birthday is on 12/09/1993 and I want to plan a dinner in Austin for 8 people. "
                 "My friends Maya Chen and Leo Garcia are coming."),
        ("assistant", "Happy early birthday! Here are some Austin spots..."),
        ("user", "I'm 33 next week, so make it fun. Leo is vegan."),
    ]),
    chatgpt_conversation("Cover letter", [
        ("user", "Polish this cover letter:\n\nDear hiring team at Contoso Health,\n\nI currently work at "
                 "Initech as a data analyst and want to move into healthcare analytics. You can see my work "
                 "at https://github.com/priya-natarajan-example and reach me on X as @priyacodes.\n\n"
                 "Best,\nPriya Natarajan"),
        ("assistant", "Here's a tighter version..."),
    ]),
    chatgpt_conversation("Lisbon trip", [
        ("user", "Plan 3 days in Lisbon for me and my sister Anika. We fly from Austin on 2026-05-14."),
        ("assistant", "Day 1: Alfama..."),
        ("user", [{"content_type": "image_asset_pointer", "asset_pointer": "file-service://file-abc123",
                   "width": 1024, "height": 768}, "Here's a photo of our itinerary, does it look right?"]),
    ]),
    chatgpt_conversation("Recipe ideas", [
        ("user", "Give me three quick dinners with chickpeas."),
        ("assistant", "1. Chickpea curry..."),
    ]),
]


def chatgpt_export_zip():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("conversations.json", json.dumps(CHATGPT_CONVERSATIONS, indent=1))
        zf.writestr("user.json", json.dumps({"id": "user-abc", "email": "priya.n@example.org",
                                             "chatgpt_plus_user": True, "phone_number": "+15125550147"}))
        zf.writestr("message_feedback.json", "[]")
        zf.writestr("shared_conversations.json", "[]")
        zf.writestr("chat.html", "<html><body><h1>Chats</h1><p>Open conversations.json for the data.</p></body></html>")
    return buf.getvalue()


# ---------- Claude data export ----------

CLAUDE_CONVERSATIONS = [
    {
        "uuid": "c1", "name": "Visa paperwork", "created_at": "2026-02-01T10:00:00Z", "updated_at": "2026-02-01T10:30:00Z",
        "account": {"uuid": "acct-1"},
        "chat_messages": [
            {"uuid": "m1", "sender": "human", "created_at": "2026-02-01T10:00:00Z",
             "text": "I'm Marcus Weber, moving from Hamburg to Toronto for a job at Northwind Logistics. "
                     "I was born on 21.11.1985. Which documents do I need?",
             "content": [{"type": "text", "text": "I'm Marcus Weber, moving from Hamburg to Toronto..."}],
             "attachments": [], "files": []},
            {"uuid": "m2", "sender": "assistant", "created_at": "2026-02-01T10:01:00Z",
             "text": "Congratulations on the move, Marcus! For a Canadian work permit you'll need...",
             "content": [{"type": "text", "text": "Congratulations on the move, Marcus!"}], "attachments": [], "files": []},
            {"uuid": "m3", "sender": "human", "created_at": "2026-02-01T10:05:00Z", "text": "",
             "content": [{"type": "text", "text": "My wife Anna Weber and our daughter Lena are coming too. "
                                                  "Contact me at marcus.weber@example.net or +49 170 555 0198."}],
             "attachments": [], "files": []},
        ],
    },
    {
        "uuid": "c2", "name": "Monthly budget", "created_at": "2026-02-03T08:00:00Z", "updated_at": "2026-02-03T08:20:00Z",
        "account": {"uuid": "acct-1"},
        "chat_messages": [
            {"uuid": "m4", "sender": "human", "created_at": "2026-02-03T08:00:00Z",
             "text": "Help me budget. My salary goes into DE89 3704 0044 0532 0130 00 and rent is 1,450 a month.",
             "content": [], "attachments": [], "files": []},
            {"uuid": "m5", "sender": "assistant", "created_at": "2026-02-03T08:01:00Z",
             "text": "Here's a 50/30/20 split for you...", "content": [], "attachments": [], "files": []},
        ],
    },
    {
        "uuid": "c3", "name": "CV review", "created_at": "2026-02-05T19:00:00Z", "updated_at": "2026-02-05T19:40:00Z",
        "account": {"uuid": "acct-1"},
        "chat_messages": [
            {"uuid": "m6", "sender": "human", "created_at": "2026-02-05T19:00:00Z",
             "text": "Can you make my CV sound less boring?", "content": [],
             "attachments": [{"file_name": "cv.txt", "file_type": "txt", "file_size": 512,
                              "extracted_content": "MARCUS WEBER\nSenior Logistics Planner, Hamburg\n"
                                                   "marcus.weber@example.net | +49 170 555 0198\n"
                                                   "Experience: Kuehne Freight (2015-2024), Hapag Shipping (2010-2015)\n"
                                                   "References: Dr. Ingrid Sommer, ingrid.sommer@example.de"}],
             "files": []},
            {"uuid": "m7", "sender": "assistant", "created_at": "2026-02-05T19:02:00Z",
             "text": "Sure, Marcus. Start with a punchier summary...", "content": [], "attachments": [], "files": []},
        ],
    },
]

CLAUDE_MEMORIES = [
    {"uuid": "mem1", "content": "Marcus is relocating to Toronto in August with his family.", "created_at": "2026-02-01"},
    {"uuid": "mem2", "content": "Prefers metric units and direct feedback.", "created_at": "2026-02-02"},
    {"uuid": "mem3", "content": "His daughter Lena starts school at Maple Grove Elementary in September.", "created_at": "2026-02-04"},
]

CLAUDE_PROJECTS = [
    {"uuid": "p1", "name": "Move to Canada", "created_at": "2026-01-20",
     "prompt_template": "Help Marcus Weber plan the family move from Hamburg to Toronto.",
     "docs": [{"uuid": "d1", "filename": "checklist.md",
               "content": "- Book movers (call Dave Kowalski at +1 416 555 0101)\n- Register Lena at school\n"
                          "- Close the Hamburg flat by 31.07.2026"}]},
]

CLAUDE_USERS = [{"uuid": "acct-1", "full_name": "Marcus Weber", "email_address": "marcus.weber@example.net",
                 "verified_phone_number": "+491705550198"}]


def claude_export_zip():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("conversations.json", json.dumps(CLAUDE_CONVERSATIONS, indent=1))
        zf.writestr("memories.json", json.dumps(CLAUDE_MEMORIES, indent=1))
        zf.writestr("projects.json", json.dumps(CLAUDE_PROJECTS, indent=1))
        zf.writestr("users.json", json.dumps(CLAUDE_USERS, indent=1))
    return buf.getvalue()


# ---------- a big export for speed testing ----------

def large_chatgpt_export_zip(target_chars=1_000_000):
    rng = random.Random(7)
    first = ["Priya", "Tom", "Ana", "Kofi", "Mia", "Lars", "Yuki", "Omar", "Elena", "Sam", "Chloe", "Ravi"]
    last = ["Natarajan", "Becker", "Lopez", "Mensah", "Ellery", "Holm", "Tanaka", "Haddad", "Rossi", "Okafor"]
    cities = ["Austin", "Leeds", "Lisbon", "Denver", "Toronto", "Melbourne", "Dublin", "Nairobi"]
    filler = [
        "Can you help me rewrite this paragraph so it sounds more confident?",
        "What's a good recipe for a quick weeknight dinner with chickpeas?",
        "Give me ten title ideas for a blog post about remote work.",
        "Summarize the main arguments for and against a four-day work week.",
        "Explain how compound interest works with a simple example.",
    ]

    def message():
        r = rng.random()
        if r < 0.15:
            return f"Draft an email to {rng.choice(first)} {rng.choice(last)} about the {rng.choice(cities)} trip."
        if r < 0.22:
            return f"My number is +1 415 555 {rng.randint(100, 199):04d}, text me the plan."
        if r < 0.27:
            return f"Use {rng.choice(first).lower()}.{rng.choice(last).lower()}@example.com as the reply-to."
        if r < 0.30:
            return "```python\nfor i in range(1000000):\n    print(i * 4155550134)\n```"
        return " ".join(rng.choice(filler) for _ in range(rng.randint(1, 4)))

    conversations, chars = [], 0
    while chars < target_chars:
        turns = []
        for i in range(12):
            if i % 2 == 0:
                text = message()
                chars += len(text)
                turns.append(("user", text))
            else:
                turns.append(("assistant", "Here you go! " + rng.choice(filler)))
        conversations.append(chatgpt_conversation(f"Chat {len(conversations)}", turns))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("conversations.json", json.dumps(conversations))
    return buf.getvalue()


# ---------- broken uploads ----------

def edge_cases():
    rng = random.Random(1)
    image = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) + bytes(rng.randrange(256) for _ in range(2048))
    junk_zip = io.BytesIO()
    with zipfile.ZipFile(junk_zip, "w") as zf:
        zf.writestr("photos/IMG_0001.png", image)
    return {
        "empty.txt": b"",
        "broken-conversations.json": b'[{"title": "Oops", "mapping": {',
        "settings-only.json": json.dumps({"theme": "dark", "language": "en", "notifications": True}).encode(),
        "photo.png": image,
        "photos-only.zip": junk_zip.getvalue(),
    }


def main():
    os.makedirs(os.path.join(OUT, "edge-cases"), exist_ok=True)
    files = {
        "chatgpt-saved-memories.txt": CHATGPT_SAVED_MEMORIES.encode(),
        "gemini-saved-info.txt": GEMINI_SAVED_INFO.encode(),
        "bot-answer-what-do-you-remember.txt": BOT_ANSWER.encode(),
        "claude-memory-summary.txt": CLAUDE_MEMORY_SUMMARY.encode(),
        "clean-memory.txt": CLEAN_MEMORY.encode(),
        "chatgpt-export.zip": chatgpt_export_zip(),
        "claude-export.zip": claude_export_zip(),
        "chatgpt-export-large.zip": large_chatgpt_export_zip(),
    }
    files.update({f"edge-cases/{name}": data for name, data in edge_cases().items()})
    for name, data in files.items():
        with open(os.path.join(OUT, name), "wb") as f:
            f.write(data)
        print(f"{name:45s} {len(data):>9,} bytes")


if __name__ == "__main__":
    main()
