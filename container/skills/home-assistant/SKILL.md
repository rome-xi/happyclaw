---
name: home-assistant
description: Control Home Assistant smart home devices — lights, switches, covers, climate, scenes, scripts, automations. Use when user asks about smart home control, checking device states, or automating home tasks. Prefer this over agent-browser for HA operations (much lower token cost).
allowed-tools: Bash(ha.sh:*)
---

# Home Assistant

Control your smart home via Home Assistant's REST API.

## Setup

Credentials are loaded from `~/.config/home-assistant/config.json` or environment variables `HA_URL` / `HA_TOKEN`.

## CLI Wrapper (`scripts/ha.sh`)

```bash
# Test connection
ha.sh info

# List entities
ha.sh list all          # all entities
ha.sh list lights       # just lights
ha.sh list switch       # just switches
ha.sh list cover        # just covers

# Search entities
ha.sh search kitchen    # find entities by name

# Get/set state
ha.sh state light.living_room
ha.sh states light.living_room   # full details with attributes
ha.sh on light.living_room
ha.sh on light.living_room 200   # with brightness (0-255)
ha.sh off light.living_room
ha.sh toggle switch.fan

# Scenes & scripts
ha.sh scene movie_night
ha.sh script goodnight

# Climate
ha.sh climate climate.thermostat 22

# Cover (blinds, curtains)
ha.sh call cover open_cover '{"entity_id":"cover.bedroom_curtain"}'
ha.sh call cover close_cover '{"entity_id":"cover.bedroom_curtain"}'
ha.sh call cover set_cover_position '{"entity_id":"cover.bedroom_curtain","position":50}'

# Call any service
ha.sh call light turn_on '{"entity_id":"light.room","brightness":200}'
```

## Common Services

| Domain | Service | Example entity_id |
|--------|---------|-------------------|
| `light` | `turn_on`, `turn_off`, `toggle` | `light.kitchen` |
| `switch` | `turn_on`, `turn_off`, `toggle` | `switch.fan` |
| `climate` | `set_temperature`, `set_hvac_mode` | `climate.thermostat` |
| `cover` | `open_cover`, `close_cover`, `stop_cover`, `set_cover_position` | `cover.bedroom_curtain` |
| `media_player` | `play_media`, `media_pause`, `volume_set` | `media_player.tv` |
| `scene` | `turn_on` | `scene.relax` |
| `script` | `turn_on` | `script.welcome_home` |
| `automation` | `trigger`, `turn_on`, `turn_off` | `automation.sunrise` |

## Troubleshooting

- **401 Unauthorized**: Token expired or invalid. Generate a new one from HA Profile page.
- **Connection refused**: Check HA_URL, ensure HA is running and accessible.
- **Entity not found**: Use `ha.sh list` or `ha.sh search` to find correct entity_id.

## API Reference

For advanced usage, see [references/api.md](references/api.md).
