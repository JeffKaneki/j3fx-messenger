# Low-data mode

The initial web client does not download media and sends only message text. Its offline outbox stores unsent text locally and retries after connectivity returns. The production media implementation should make previews opt-in, use compressed derivatives, paginate attachments, and require explicit downloads on cellular connections.
