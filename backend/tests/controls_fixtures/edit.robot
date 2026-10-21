*** Settings ***
Documentation    Synthetic breakpoint editing fixture.
Resource    controls.resource

*** Test Cases ***
Edit Breakpoints
    Log    edit-first
    Log    edit-second
    Log    edit-third
    Log    edit-fourth
    Inner    edit
    Log    edit-fifth
