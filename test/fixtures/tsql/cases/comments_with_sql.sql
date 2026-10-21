-- DELETE FROM dbo.X WHERE 1 = 1
/* outer /* nested */ UPDATE dbo.Y SET a = 1 */
SELECT Id FROM dbo.RealTable -- trailing comment: EXEC dbo.NotCalled
/* EXEC dbo.AlsoNotCalled
   INSERT INTO dbo.NotWritten VALUES (1) */
-- EXEC [dbo].[CommentedProc] @a = 1
