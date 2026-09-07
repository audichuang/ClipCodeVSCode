"""Diagnose Git's actual bisect completion text; uses only a disposable repo."""
import json
import os
import subprocess
import tempfile
from pathlib import Path

with tempfile.TemporaryDirectory(prefix="snipcode-bisect-qa-") as directory:
    def git(*args):
        return subprocess.check_output(
            ["git", "-C", directory, *args], stderr=subprocess.STDOUT, text=True,
            env={**os.environ, "LC_ALL": "C", "GIT_CONFIG_GLOBAL": "/dev/null",
                 "GIT_CONFIG_SYSTEM": "/dev/null"},
        ).strip()

    git("init", "-b", "main")
    git("config", "user.name", "QA")
    git("config", "user.email", "qa@example.invalid")
    git("config", "commit.gpgsign", "false")
    for number in range(4):
        Path(directory, "sample.txt").write_text(f"revision {number}\n")
        git("add", ".")
        git("commit", "-m", f"revision {number}")
    output = git("bisect", "start", "HEAD", "HEAD~3")
    for _ in range(4):
        output = git("bisect", "bad")
        if "first" in output:
            break
    assert "first" in output, output
    print(json.dumps({
        "git_version": git("--version"),
        "completion_line": output.splitlines()[0],
        "current_ui_recognizes_completion": "is the first bad commit" in output,
    }, indent=2))
