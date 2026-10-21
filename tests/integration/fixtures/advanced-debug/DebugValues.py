class Holder:
    """A Python object: inspectable in the Robot session, never editable there."""

    def __init__(self):
        self.counter = 1


def make_holder():
    return Holder()


def python_count(text):
    counter = len(text)
    return counter
