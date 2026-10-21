SELECT a.Id FROM dbo.Books a WITH (NOLOCK) JOIN dbo.Authors o WITH (NOLOCK, INDEX(IX_Authors)) ON o.Id = a.AuthorId
SELECT * FROM dbo.Legacy (NOLOCK)
SELECT * FROM dbo.LegacyAliased la (NOLOCK) WHERE la.Id = 1
SELECT * FROM dbo.Comma1 c1 WITH (NOLOCK), dbo.Comma2 c2 WHERE c1.Id = c2.Id
UPDATE dbo.Hinted WITH (ROWLOCK) SET Flag = 1 WHERE Id = 2
