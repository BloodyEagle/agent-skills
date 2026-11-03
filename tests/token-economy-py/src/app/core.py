"""Ядро."""
import json
import os
from .models import User


class Engine:
    def run(self, x: int) -> int:
        return x * 2


def helper(items):
    return [json.dumps(i) for i in items]
