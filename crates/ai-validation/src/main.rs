mod validation;

#[tokio::main]
async fn main() {
    match validation::run(std::env::args_os().skip(1).collect()).await {
        Ok(value) => match serde_json::to_string_pretty(&value) {
            Ok(json) => println!("{json}"),
            Err(_) => std::process::exit(1),
        },
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
