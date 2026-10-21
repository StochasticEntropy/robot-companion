*** Settings ***
Documentation    Synthetic test that waits in a child process until the run is stopped.
Library    WaitLibrary.py

*** Test Cases ***
Waits For Stop
    Wait In Child Process    300
