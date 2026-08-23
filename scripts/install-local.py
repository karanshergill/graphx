#!/usr/bin/env python3

import argparse
import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.request
import uuid


INSTALL_MUTATION = """
mutation InstallGraphX($input: InstallPluginPackageInput!) {
  installPluginPackage(input: $input) {
    package {
      id
      manifestId
      name
      version
      plugins {
        __typename
        id
        manifestId
        enabled
        ... on PluginBackend {
          state {
            running
            error
          }
        }
      }
    }
    error {
      __typename
    }
  }
}
"""


def token() -> str:
    candidates = [
        Path("/root/.caido/token.json"),
        Path("/home/me/.caido/token.json"),
    ]
    for candidate in candidates:
        try:
            document = json.loads(candidate.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        value = document.get("accessToken") or document.get("access_token")
        if isinstance(value, str) and value:
            return value
    raise RuntimeError("No readable Caido access token was found")


def multipart_body(archive: Path) -> tuple[str, bytes]:
    boundary = f"graphx-{uuid.uuid4().hex}"
    operations = {
        "query": INSTALL_MUTATION,
        "variables": {
            "input": {
                "force": True,
                "source": {"file": None},
            }
        },
    }
    mapping = {"0": ["variables.input.source.file"]}
    chunks: list[bytes] = []

    def field(name: str, value: str) -> None:
        chunks.extend(
            [
                f"--{boundary}\r\n".encode(),
                f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode(),
                value.encode(),
                b"\r\n",
            ]
        )

    field("operations", json.dumps(operations))
    field("map", json.dumps(mapping))
    chunks.extend(
        [
            f"--{boundary}\r\n".encode(),
            b'Content-Disposition: form-data; name="0"; filename="plugin_package.zip"\r\n',
            b"Content-Type: application/zip\r\n\r\n",
            archive.read_bytes(),
            b"\r\n",
            f"--{boundary}--\r\n".encode(),
        ]
    )
    return boundary, b"".join(chunks)


def install(caido_url: str, archive: Path) -> dict[str, object]:
    boundary, body = multipart_body(archive)
    request = urllib.request.Request(
        f"{caido_url.rstrip('/')}/graphql",
        data=body,
        headers={
            "Authorization": f"Bearer {token()}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        },
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.loads(response.read())


def main() -> int:
    parser = argparse.ArgumentParser(description="Install a local GraphX build in Caido")
    parser.add_argument(
        "archive",
        nargs="?",
        type=Path,
        default=Path("dist/plugin_package.zip"),
    )
    parser.add_argument(
        "--caido-url",
        default=os.environ.get("CAIDO_URL", "http://127.0.0.1:8080"),
    )
    arguments = parser.parse_args()

    if not arguments.archive.is_file():
        parser.error(f"archive does not exist: {arguments.archive}")

    try:
        result = install(arguments.caido_url, arguments.archive)
    except (OSError, RuntimeError, urllib.error.URLError) as error:
        print(str(error), file=sys.stderr)
        return 1

    print(json.dumps(result, indent=2, default=str))
    payload = result.get("data")
    if not isinstance(payload, dict):
        return 1
    installation = payload.get("installPluginPackage")
    if not isinstance(installation, dict):
        return 1
    return 0 if installation.get("package") is not None else 1


if __name__ == "__main__":
    raise SystemExit(main())
