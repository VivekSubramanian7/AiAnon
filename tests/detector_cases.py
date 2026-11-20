"""Shared detector fixture strings for pytest and web_fixtures_detectors.py."""

CASES = [
    ("pem", "-----BEGIN RSA PRIVATE KEY-----", False),
    ("aws", "key: AKIAIOSFODNN7EXAMPLE here", False),
    ("ghp", "ghp_abcdefghijklmnopqrst", False),
    ("token_url", "https://s3.amazonaws.com/x?X-Amz-Signature=abc123def456ghi789jkl012mno345", False),
    ("jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", False),
    ("health_cue", "I have asthma", False),
    ("health_low", "asthma", False),
    ("religion", "I'm Christian", False),
    ("children", "my daughter Zoë", False),
    ("street", "flat 4B at 18 Elm Grove", False),
    ("payment_card", "card: 4242 4242 4242 4242", False),
    ("ssn", "SSN 123-45-6789", False),
    ("linkedin", "https://www.linkedin.com/in/priya-n", False),
    ("github", "https://github.com/octocat", False),
    ("github_deny", "https://github.com/features", False),
    ("fence_pem", "-----BEGIN OPENSSH PRIVATE KEY-----", True),
    ("fence_no_health", "I have asthma", True),
    ("gps", "coords 37.77490, -122.41940", False),
]