from app.core import Engine


def test_run():
    assert Engine().run(2) == 4
