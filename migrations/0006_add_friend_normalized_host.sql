ALTER TABLE friend_links ADD COLUMN normalized_host TEXT NOT NULL DEFAULT '';

UPDATE friend_links
SET normalized_host = lower(
	CASE
		WHEN instr(replace(replace(url, 'https://www.', ''), 'https://', ''), '/') > 0
		THEN substr(
			replace(replace(url, 'https://www.', ''), 'https://', ''),
			1,
			instr(replace(replace(url, 'https://www.', ''), 'https://', ''), '/') - 1
		)
		ELSE replace(replace(url, 'https://www.', ''), 'https://', '')
	END
)
WHERE normalized_host = '';

CREATE INDEX IF NOT EXISTS idx_friend_links_normalized_host_status
ON friend_links (normalized_host, status);
