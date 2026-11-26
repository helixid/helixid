# Helix Stay -- the Hotel SP. Catalog: book:hotel. Entirely independent of
# the Airline SP: its own DID, its own status list, its own grants.
from dotenv import load_dotenv

load_dotenv()

from helixid_config import HOTEL  # noqa: E402
from sp_shared.serve import serve_sp  # noqa: E402

if __name__ == "__main__":
    serve_sp(HOTEL)
