// handle vote
// Coded with Cairo 2.15.2
// contract not audited ; use at your own risks.

#[starknet::interface]
trait IstorageFelts<TContractState> {
    fn get_size_bytes(self: @TContractState) -> u16;
}


#[starknet::contract]
mod StorageFelts {
    #[storage]
    struct Storage {
        size_bytes: u16,
    }

    #[constructor]
    fn constructor(ref self: ContractState, file: BinaryFile) {
        self.size_bytes.write(file.size_bytes);
    }

    #[abi(embed_v0)]
    impl TestFelt of super::IstorageFelts<ContractState> {
        fn get_size_bytes(self: @ContractState) -> u16 {
            self.size_bytes.read()
        }
    }
}
