# Saved sample API responses

One folder per connector (`fixtures/teller/`, `fixtures/plaid/`, ...). Each file
is a provider response shaped like the real API, with invented values only.
Adapter tests load these until real developer keys exist. Never save a
response from a real account here: the repo is public.
