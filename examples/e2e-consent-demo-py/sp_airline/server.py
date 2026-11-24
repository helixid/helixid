# Helix Air -- the Airline SP. Catalog: book:flights, modify:booking.
from dotenv import load_dotenv

load_dotenv()

from helixid_config import AIRLINE  # noqa: E402
from sp_shared.serve import serve_sp  # noqa: E402

if __name__ == "__main__":
    serve_sp(AIRLINE)
