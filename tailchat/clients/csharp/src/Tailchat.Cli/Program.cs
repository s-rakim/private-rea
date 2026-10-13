using System.Text;
using Tailchat.Cli;

Console.OutputEncoding = Encoding.UTF8;
using var cts = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) =>
{
    e.Cancel = true;
    cts.Cancel();
};
return await CliApp.RunAsync(args, Console.Out, Console.Error, cts.Token);
