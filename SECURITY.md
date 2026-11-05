# Security

## Reporting a vulnerability

Please report vulnerabilities privately through [GitHub security advisories](https://github.com/swarmloop/swarmloop/security/advisories/new). Do not open a public issue for an unpatched vulnerability.

## Trust model

By default, sandbox containers granted network access can reach external hosts only through the egress proxy, which filters destinations by host. Claude and Codex API keys stay outside the container and are replaced by the proxy. Cursor keys and the Codex ChatGPT login cannot be replaced and stay inside the container.

The server holds the Docker socket and can control containers on its host. The application has no login; network access to the server is the access control. Anyone who can reach it can use the panel and see run history. Treat the server and its network accordingly.
