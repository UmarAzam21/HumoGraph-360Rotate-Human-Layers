import logging


def setup_logging(debug: bool = False) -> None:
    logging.basicConfig(
        level=logging.DEBUG if debug else logging.INFO,
        format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
    )
    # httpx logs every request at INFO; keep it quiet unless debugging.
    logging.getLogger("httpx").setLevel(logging.DEBUG if debug else logging.WARNING)
