"""Discounts of the synthetic coverage workspace."""


def discount(price):
    if price > 1000:
        return price // 5
    return price // 10
