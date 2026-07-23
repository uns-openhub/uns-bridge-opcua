# Security policy

Report vulnerabilities through GitHub private vulnerability reporting, not a
public issue.

Never commit controller credentials, OPC UA credentials, client certificates,
private node mappings, generated live metadata, or runtime state. The
management API requires controller JWKS authentication.
