"""CLI helper that turns a password into the hash ``AUTH_PASSWORD_HASH`` expects.

Run it once per deployment and paste the output into the environment::

    uv run python -m summa.hashpw

The application itself never accepts a plaintext password, so this is the only
place a password is typed — reading it via ``getpass`` keeps it out of the shell
history. Pass it as an argument only for throwaway local setups.
"""

import getpass
import sys

from werkzeug.security import generate_password_hash


def main() -> None:
    """Print the hash of the password given as an argument or read interactively."""
    if len(sys.argv) > 2:
        print("usage: python -m summa.hashpw [password]", file=sys.stderr)
        raise SystemExit(2)

    password: str = sys.argv[1] if len(sys.argv) == 2 else getpass.getpass("Password: ")
    if not password:
        print("Password must not be empty", file=sys.stderr)
        raise SystemExit(1)

    print(generate_password_hash(password))


if __name__ == "__main__":
    main()
